import { checkEvidence, checkRange, type LineSource } from './evidence.js';
import {
  FindingInputSchema,
  VerdictInputSchema,
  formatZodError,
  type Category,
  type Finding,
  type VerdictInput,
} from './finding.js';
import { fingerprint } from './fingerprint.js';
import { judge, type JudgeOptions, type JudgeResult } from './judge.js';

export type Stage = 'reviewing' | 'verifying' | 'finalized';

export type RunErrorCode =
  | 'wrong-stage'
  | 'unknown-specialist'
  | 'specialists-pending'
  | 'too-many-findings'
  | 'bad-batch'
  | 'missing-verdicts'
  | 'invalid-verdict';

export class RunStateError extends Error {
  constructor(
    readonly code: RunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunStateError';
  }
}

export interface SubmitResult {
  readonly accepted: Finding[];
  readonly rejected: { readonly index: number; readonly reason: string }[];
}

export interface RunState {
  readonly id: string;
  readonly stage: Stage;
  readonly specialists: readonly Category[];
  readonly pendingSpecialists: Category[];
  /** Specialists that could not run (for example stopped by a safeguard); their area is not covered. */
  readonly skippedSpecialists: { readonly specialist: Category; readonly reason: string }[];
  readonly findingCount: number;
  readonly batchId: string | null;
}

export const MAX_FINDINGS_PER_SUBMISSION = 50;

/**
 * One review run. Enforces the order the pipeline depends on: every planned specialist submits,
 * then verification starts, then finalize needs a verdict for every finding. It cannot prove the
 * verifier ran in a fresh context; it can only refuse incomplete or out-of-order work.
 */
export class ReviewRun {
  private stage: Stage = 'reviewing';
  private readonly findings: Finding[] = [];
  private readonly submitted = new Set<Category>();
  private readonly skipped = new Map<Category, string>();
  private batchId: string | null = null;
  private nextId = 1;

  private readonly planned: Category[];

  constructor(
    readonly id: string,
    specialists: readonly Category[],
    private readonly source: LineSource,
    private readonly newBatchId: () => string = () => `${id}-verify`,
  ) {
    this.planned = [...specialists];
  }

  get specialists(): readonly Category[] {
    return this.planned;
  }

  /** Adds a specialist while the review is still open (e.g. requirements once a linked issue arrives). */
  addSpecialist(category: Category): void {
    this.requireStage('reviewing');
    if (!this.planned.includes(category)) this.planned.push(category);
  }

  submitFindings(specialist: string, inputs: readonly unknown[]): SubmitResult {
    this.requireStage('reviewing');
    const owner = this.specialists.find((s) => s === specialist);
    if (!owner) {
      throw new RunStateError('unknown-specialist', `"${specialist}" is not in this run's plan: ${this.specialists.join(', ')}`);
    }
    if (inputs.length > MAX_FINDINGS_PER_SUBMISSION) {
      throw new RunStateError('too-many-findings', `at most ${MAX_FINDINGS_PER_SUBMISSION} findings per submission`);
    }

    const accepted: Finding[] = [];
    const rejected: SubmitResult['rejected'] = [];
    inputs.forEach((raw, index) => {
      const parsed = FindingInputSchema.safeParse(raw);
      if (!parsed.success) return rejected.push({ index, reason: formatZodError(parsed.error) });
      const check = checkEvidence(parsed.data, this.source);
      if (!check.ok) return rejected.push({ index, reason: check.reason });
      const finding: Finding = {
        ...parsed.data,
        id: `f${this.nextId++}`,
        specialist: owner,
        fingerprint: fingerprint(parsed.data),
      };
      accepted.push(finding);
      return undefined;
    });
    this.findings.push(...accepted);
    this.submitted.add(owner);
    // A specialist recorded as skipped that reports after all is covered again.
    this.skipped.delete(owner);
    return { accepted, rejected };
  }

  /**
   * Records that a specialist could not run, so the review can still be verified and finalized.
   * Its area is reported as not covered; findings it already submitted stay. Refused once it submitted.
   */
  skipSpecialist(specialist: string, reason: string): void {
    this.requireStage('reviewing');
    const owner = this.specialists.find((s) => s === specialist);
    if (!owner) {
      throw new RunStateError('unknown-specialist', `"${specialist}" is not in this run's plan: ${this.specialists.join(', ')}`);
    }
    if (this.submitted.has(owner)) throw new RunStateError('wrong-stage', `"${owner}" already submitted; nothing to skip`);
    this.skipped.set(owner, reason.trim().slice(0, 300) || 'not given');
    this.submitted.add(owner);
  }

  /** Idempotent once verifying, so a crashed verifier can fetch the same batch again. */
  startVerification(): { batchId: string; findings: readonly Finding[] } {
    if (this.stage === 'verifying' && this.batchId) return { batchId: this.batchId, findings: this.findings };
    this.requireStage('reviewing');
    const pending = this.pendingSpecialists();
    if (pending.length > 0) {
      throw new RunStateError('specialists-pending', `waiting for: ${pending.join(', ')} (submit an empty list if none)`);
    }
    this.stage = 'verifying';
    this.batchId = this.newBatchId();
    return { batchId: this.batchId, findings: this.findings };
  }

  finalize(batchId: string, rawVerdicts: readonly unknown[], opts: JudgeOptions = {}): JudgeResult {
    this.requireStage('verifying');
    if (batchId !== this.batchId) throw new RunStateError('bad-batch', 'batch id does not match the verification batch');

    const verdicts = rawVerdicts.map((raw, i) => this.parseVerdict(raw, i));
    const seen = new Set<string>();
    for (const v of verdicts) {
      if (seen.has(v.findingId)) throw new RunStateError('invalid-verdict', `two verdicts for ${v.findingId}`);
      seen.add(v.findingId);
    }
    const missing = this.findings.filter((f) => !seen.has(f.id)).map((f) => f.id);
    if (missing.length > 0) throw new RunStateError('missing-verdicts', `no verdict for: ${missing.join(', ')}`);

    const result = judge(this.findings, verdicts, opts);
    this.stage = 'finalized';
    return result;
  }

  state(): RunState {
    return {
      id: this.id,
      stage: this.stage,
      specialists: this.specialists,
      pendingSpecialists: this.pendingSpecialists(),
      skippedSpecialists: [...this.skipped].map(([specialist, reason]) => ({ specialist, reason })),
      findingCount: this.findings.length,
      batchId: this.batchId,
    };
  }

  private parseVerdict(raw: unknown, index: number): VerdictInput {
    const parsed = VerdictInputSchema.safeParse(raw);
    if (!parsed.success) throw new RunStateError('invalid-verdict', `verdict ${index}: ${formatZodError(parsed.error)}`);
    const v = parsed.data;
    const finding = this.findings.find((f) => f.id === v.findingId);
    if (!finding) throw new RunStateError('invalid-verdict', `verdict ${index}: unknown finding ${v.findingId}`);
    const allowed = new Set([finding.file, ...finding.evidence.map((e) => e.file)]);
    if (!allowed.has(v.citation.file)) {
      throw new RunStateError('invalid-verdict', `verdict ${index}: cite code in ${[...allowed].join(' or ')}`);
    }
    const cite = checkRange(v.citation, this.source);
    if (!cite.ok) throw new RunStateError('invalid-verdict', `verdict ${index}: citation invalid: ${cite.reason}`);
    return v;
  }

  private pendingSpecialists(): Category[] {
    return this.specialists.filter((s) => !this.submitted.has(s));
  }

  private requireStage(expected: Stage): void {
    if (this.stage !== expected) {
      throw new RunStateError('wrong-stage', `run is ${this.stage}; this call needs it to be ${expected}`);
    }
  }
}

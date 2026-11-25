import {
  buildRequirementsPrompt,
  buildRulesPrompt,
  buildSummaryPrompt,
  carryOver,
  checksLine,
  diagnosticFingerprint,
  diffPaths,
  issuesText,
  onChangedLines,
  parseBaselineReply,
  parseSummary,
  redactSecrets,
  restrictDiff,
  type BaselineFinding,
  type CiCheck,
  type PrSummary,
} from '@repospector/core';
import type { Effort } from '../providers/types.js';
import type { PrExtras, ReviewFinding, RunRecord } from './run-types.js';

/**
 * The passes beside the measured review: walkthrough, team rules, linked issues, CI results, and
 * re-review of only what changed. Each is optional and fails alone: a failure becomes a note and the
 * measured review still stands.
 */
export type Call = (prompt: string, effort: Effort) => Promise<string>;

/** Rules and issue texts kept on the run while it is in progress (for resume); names and CI results stay. */
export function extrasRecord(x: PrExtras): NonNullable<RunRecord['extras']> {
  return {
    rulesText: x.rules.text ? redactSecrets(x.rules.text) : undefined,
    rulesFiles: x.rules.files,
    issuesText: x.issues.length ? issuesText(x.issues) : undefined,
    issueRefs: x.issues.map((i) => i.ref),
    ticketKeys: x.ticketKeys,
    checks: x.checks,
  };
}

export interface ExtraResults {
  readonly summary?: PrSummary | null | undefined;
  readonly rulesReview?: readonly BaselineFinding[] | undefined;
  readonly requirementsReview?: readonly BaselineFinding[] | undefined;
  readonly notes: string[];
}

/** Runs the passes the run still needs, in parallel; already stored results are reused on resume. */
export async function runExtraPasses(run: RunRecord, title: string, diff: string, call: Call): Promise<ExtraResults> {
  const notes: string[] = [];
  const findingsPass = async (prompt: string, what: string): Promise<readonly BaselineFinding[]> => {
    try {
      const r = parseBaselineReply(await call(prompt, 'medium'));
      if (!r) notes.push(`The ${what} reply could not be read, so that check is missing from this review.`);
      return r ?? [];
    } catch (e) {
      notes.push(`The ${what} did not run (${(e as Error).message}).`);
      return [];
    }
  };
  const summary = async (): Promise<PrSummary | null | undefined> => {
    if (run.summary !== undefined) return run.summary;
    try {
      return parseSummary(await call(buildSummaryPrompt(title, diff), 'low'));
    } catch {
      return null;
    }
  };
  const rulesText = run.extras?.rulesText;
  const issues = run.extras?.issuesText;
  const [s, rules, reqs] = await Promise.all([
    summary(),
    run.rulesReview ?? (rulesText ? findingsPass(buildRulesPrompt(title, diff, rulesText), 'team-rules check') : undefined),
    run.requirementsReview ?? (issues ? findingsPass(buildRequirementsPrompt(title, diff, issues), 'linked-issue check') : undefined),
  ]);
  return { summary: s, rulesReview: rules, requirementsReview: reqs, notes };
}

const CI_CONFIDENCE = { error: 90, warning: 60, notice: 30 } as const;

/** CI problems on lines the pull request adds or changes, as findings (tool output, not model text). */
export function ciFindings(checks: readonly CiCheck[] | null | undefined, diff: string, startId: number): ReviewFinding[] {
  const diags = onChangedLines((checks ?? []).flatMap((c) => c.diagnostics), diff).slice(0, 50);
  return diags.map((d, i) => ({
    id: `f${startId + i}`,
    file: d.file,
    line: d.line,
    claim: `${d.source}: ${d.message}`,
    status: 'verified',
    confidence: CI_CONFIDENCE[d.level],
    impact: d.level === 'error' ? 'medium' : 'low',
    source: 'ci',
    fingerprint: diagnosticFingerprint(d),
    category: 'ci',
  }));
}

/** Notes about what the extra inputs covered, shown under "About this review". */
export function extrasNotes(run: RunRecord, checksError?: string): string[] {
  const x = run.extras;
  const notes: string[] = [];
  if (!x) return notes;
  if (x.rulesFiles.length) notes.push(`Checked against the team rules in ${x.rulesFiles.join(', ')} (from the pull request base).`);
  if (x.issueRefs.length) notes.push(`Checked against the linked issue${x.issueRefs.length === 1 ? '' : 's'} ${x.issueRefs.join(', ')}.`);
  if (x.ticketKeys.length) notes.push(`Mentions ${x.ticketKeys.join(', ')}; tickets outside GitHub/GitLab are not read by the extension.`);
  if (x.checks) notes.push(checksLine(x.checks));
  else if (checksError) notes.push(`CI results were not read (${checksError}).`);
  return notes;
}

export interface Incremental {
  readonly diff: string;
  readonly carried: ReviewFinding[];
  readonly files: number;
}

/**
 * Re-review: the PR diff restricted to files changed since the previous reviewed head, and the
 * previous findings in other files that are still part of the pull request.
 */
export function incrementalReview(fullDiff: string, changed: readonly string[], previous: readonly ReviewFinding[]): Incremental {
  const set = new Set(changed);
  const diff = restrictDiff(fullDiff, set);
  const carried = carryOver(previous, set, diffPaths(fullDiff)).map((f) => ({ ...f, carried: true as const, id: `p${f.id}` }));
  return { diff, carried, files: diffPaths(diff).size };
}

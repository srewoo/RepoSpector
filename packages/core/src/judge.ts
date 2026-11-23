import { SEVERITIES, type Category, type Finding, type JudgedFinding, type VerdictInput } from './finding.js';

export interface Calibration {
  /** Expected precision for a finding of this category at this raw confidence; undefined if not measured. */
  expectedPrecision(category: Category, confidence: number): number | undefined;
}

export interface JudgeOptions {
  /** Threshold on raw confidence, used when no calibration applies. */
  readonly minConfidence?: number;
  readonly calibration?: Calibration;
  /** Threshold on calibrated expected precision. */
  readonly minExpectedPrecision?: number;
  /**
   * Drop refuted and low-confidence findings instead of keeping them as suspected. Off by default:
   * a missed bug costs more than a noisy comment, and the verifier also refutes real bugs.
   */
  readonly dropSuspected?: boolean;
}

export type DropReason = 'refuted' | 'below-threshold' | 'duplicate';

export interface Dropped {
  readonly id: string;
  readonly reason: DropReason;
  readonly detail: string;
}

export interface JudgeResult {
  readonly kept: JudgedFinding[];
  readonly dropped: Dropped[];
}

const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_MIN_EXPECTED_PRECISION = 0.7;

const severityRank = (f: Finding): number => SEVERITIES.indexOf(f.severity);

const statusRank = (f: JudgedFinding): number => (f.status === 'verified' ? 0 : 1);

/** Verified before suspected, then higher severity, higher confidence, earlier id for stable output. */
function compare(a: JudgedFinding, b: JudgedFinding): number {
  return (
    statusRank(a) - statusRank(b) ||
    severityRank(a) - severityRank(b) ||
    b.confidence - a.confidence ||
    a.id.localeCompare(b.id, 'en', { numeric: true })
  );
}

const NEAR_LINES = 10;

/** Same file and category, and either overlapping lines or the same fingerprint within a few lines. */
function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file || a.category !== b.category) return false;
  if (a.startLine <= b.endLine && b.startLine <= a.endLine) return true;
  return a.fingerprint === b.fingerprint && Math.abs(a.startLine - b.startLine) <= NEAR_LINES;
}

/**
 * Apply verifier verdicts, the confidence threshold and de-duplication. Every finding must
 * already have a verdict; callers enforce that.
 */
export function judge(findings: readonly Finding[], verdicts: readonly VerdictInput[], opts: JudgeOptions = {}): JudgeResult {
  const byId = new Map(verdicts.map((v) => [v.findingId, v]));
  const dropped: Dropped[] = [];
  const candidates: JudgedFinding[] = [];

  for (const f of findings) {
    const verdict = byId.get(f.id);
    if (!verdict) throw new Error(`missing verdict for ${f.id}`);
    const expectedPrecision = opts.calibration?.expectedPrecision(f.category, f.confidence) ?? null;
    const passes =
      expectedPrecision === null
        ? f.confidence >= (opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE)
        : expectedPrecision >= (opts.minExpectedPrecision ?? DEFAULT_MIN_EXPECTED_PRECISION);
    const lowConfidence = expectedPrecision === null ? `confidence ${f.confidence}` : `expected precision ${expectedPrecision}`;
    const suspicion = !verdict.keep
      ? { reason: 'refuted' as const, detail: verdict.reason, label: `verifier: ${verdict.reason}` }
      : !passes
        ? { reason: 'below-threshold' as const, detail: lowConfidence, label: lowConfidence }
        : null;
    if (suspicion && opts.dropSuspected) {
      dropped.push({ id: f.id, reason: suspicion.reason, detail: suspicion.detail });
      continue;
    }
    candidates.push(
      suspicion
        ? { ...f, verdict, expectedPrecision, status: 'suspected', suspectedBecause: suspicion.label }
        : { ...f, verdict, expectedPrecision, status: 'verified' },
    );
  }

  // Strongest first (verified before suspected); a finding is a duplicate only if it matches one already kept. Not transitive,
  // so a chain of partly overlapping findings cannot swallow a distinct bug at the far end.
  const kept: JudgedFinding[] = [];
  for (const f of [...candidates].sort(compare)) {
    const winner = kept.find((k) => isDuplicate(k, f));
    if (winner) dropped.push({ id: f.id, reason: 'duplicate', detail: `duplicate of ${winner.id}` });
    else kept.push(f);
  }
  return { kept, dropped };
}

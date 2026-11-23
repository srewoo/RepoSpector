import type { GoldenCase, GoldenIssue, Prediction } from './golden.js';

export interface CaseMatch {
  readonly matches: { issueId: string; predictionIndex: number }[];
  readonly falsePositives: number[];
  readonly missed: string[];
}

export interface Totals {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** Null when undefined (no predictions, or no issues for recall). */
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

export interface CaseScore extends CaseMatch {
  readonly id: string;
}

export interface RunScore {
  readonly tolerance: number;
  readonly cases: CaseScore[];
  readonly totals: Totals;
  /** Cases with no entry in the predictions file; usually a failed run, not a clean review. */
  readonly missingPredictions: string[];
  readonly unknownCases: string[];
}

export interface ScoreOptions {
  readonly tolerance: number;
  readonly split?: GoldenCase['split'];
}

/** Gap in lines between two ranges; 0 when they overlap. */
function gap(issue: GoldenIssue, p: Prediction): number {
  if (p.endLine < issue.line) return issue.line - p.endLine;
  if (p.startLine > issue.endLine) return p.startLine - issue.endLine;
  return 0;
}

/**
 * One-to-one matching: all same-file pairs within tolerance, assigned closest first.
 * Greedy-by-distance is deterministic and close to optimal for the small sets a review produces.
 */
export function matchCase(issues: readonly GoldenIssue[], predictions: readonly Prediction[], tolerance: number): CaseMatch {
  const pairs: { issue: number; pred: number; dist: number }[] = [];
  issues.forEach((issue, i) =>
    predictions.forEach((p, j) => {
      if (p.file !== issue.file) return;
      const dist = gap(issue, p);
      if (dist <= tolerance) pairs.push({ issue: i, pred: j, dist });
    }),
  );
  pairs.sort((a, b) => a.dist - b.dist || a.pred - b.pred || a.issue - b.issue);

  const usedIssues = new Set<number>();
  const usedPreds = new Set<number>();
  const matches: CaseMatch['matches'] = [];
  for (const { issue, pred } of pairs) {
    if (usedIssues.has(issue) || usedPreds.has(pred)) continue;
    usedIssues.add(issue);
    usedPreds.add(pred);
    matches.push({ issueId: issues[issue]?.id ?? '', predictionIndex: pred });
  }
  matches.sort((a, b) => a.predictionIndex - b.predictionIndex);
  return {
    matches,
    falsePositives: predictions.map((_, j) => j).filter((j) => !usedPreds.has(j)),
    missed: issues.filter((_, i) => !usedIssues.has(i)).map((i) => i.id),
  };
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export function totals(cases: readonly CaseMatch[]): Totals {
  const tp = cases.reduce((n, c) => n + c.matches.length, 0);
  const fp = cases.reduce((n, c) => n + c.falsePositives.length, 0);
  const fn = cases.reduce((n, c) => n + c.missed.length, 0);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

export function scoreRun(
  cases: readonly GoldenCase[],
  predictions: Readonly<Record<string, readonly Prediction[]>>,
  opts: ScoreOptions,
): RunScore {
  const selected = opts.split ? cases.filter((c) => c.split === opts.split) : [...cases];
  const known = new Set(cases.map((c) => c.id));
  const scored = selected.map((c) => ({ id: c.id, ...matchCase(c.issues, predictions[c.id] ?? [], opts.tolerance) }));
  return {
    tolerance: opts.tolerance,
    cases: scored,
    totals: totals(scored),
    missingPredictions: selected.filter((c) => !(c.id in predictions)).map((c) => c.id),
    unknownCases: Object.keys(predictions).filter((id) => !known.has(id)),
  };
}

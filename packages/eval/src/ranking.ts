/**
 * Precision at the top N findings per PR: what a reviewer who reads only the first N actually sees.
 * A finding is real when the judge matched it to any golden comment.
 */
export interface RankedCase {
  /** Candidate texts in the order shown to the reviewer. */
  readonly order: readonly string[];
  readonly golden: readonly string[];
  readonly matches: readonly { golden: string; candidate: string }[];
}

export interface TopN {
  readonly n: number;
  readonly shown: number;
  readonly real: number;
  readonly precision: number;
  /** Expected precision if the same findings were shown in random order. */
  readonly randomPrecision: number;
  readonly goldensFound: number;
  readonly goldens: number;
  readonly recall: number;
}

export function topN(cases: readonly RankedCase[], n: number): TopN {
  let shown = 0;
  let real = 0;
  let expected = 0;
  let goldensFound = 0;
  let goldens = 0;
  for (const c of cases) {
    const realSet = new Set(c.matches.map((m) => m.candidate));
    const top = c.order.slice(0, n);
    const topSet = new Set(top);
    shown += top.length;
    real += top.filter((t) => realSet.has(t)).length;
    if (c.order.length) expected += (top.length * c.order.filter((t) => realSet.has(t)).length) / c.order.length;
    goldens += c.golden.length;
    goldensFound += c.golden.filter((g) => c.matches.some((m) => m.golden === g && topSet.has(m.candidate))).length;
  }
  return { n, shown, real, precision: shown ? real / shown : 0, randomPrecision: shown ? expected / shown : 0, goldensFound, goldens, recall: goldens ? goldensFound / goldens : 0 };
}

/** Probability that a random real finding scores above a random false one (ties count ½). NaN without both kinds. */
export function auc(scored: readonly { readonly score: number; readonly real: boolean }[]): number {
  const pos = scored.filter((s) => s.real);
  const neg = scored.filter((s) => !s.real);
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

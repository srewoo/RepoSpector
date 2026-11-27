import { describe, expect, it } from 'vitest';
import { auc, topN, type RankedCase } from '../src/ranking.js';

// Two PRs. A: 4 findings, real ones are b and d (d matches golden G2, b matches G1).
// B: 1 finding, real (matches G3); one golden G4 never found.
const cases: RankedCase[] = [
  { order: ['a', 'b', 'c', 'd'], golden: ['G1', 'G2'], matches: [{ golden: 'G1', candidate: 'b' }, { golden: 'G2', candidate: 'd' }] },
  { order: ['x'], golden: ['G3', 'G4'], matches: [{ golden: 'G3', candidate: 'x' }] },
];

describe('topN', () => {
  it('counts real findings among the first N per PR, and goldens they cover', () => {
    const r1 = topN(cases, 1);
    expect(r1).toMatchObject({ shown: 2, real: 1, goldensFound: 1, goldens: 4 });
    expect(r1.precision).toBeCloseTo(0.5);
    // Random order: A expects 1 * 2/4, B expects 1 * 1/1.
    expect(r1.randomPrecision).toBeCloseTo(1.5 / 2);
    const r2 = topN(cases, 2);
    expect(r2).toMatchObject({ shown: 3, real: 2, goldensFound: 2 });
    expect(r2.recall).toBeCloseTo(2 / 4);
  });

  it('uses every finding when N exceeds a PR\'s count (top-all equals the whole run)', () => {
    expect(topN(cases, 99)).toMatchObject({ shown: 5, real: 3, goldensFound: 3 });
    expect(topN(cases, 99).precision).toBeCloseTo(topN(cases, 99).randomPrecision);
  });

  it('counts a finding that matches two goldens once as shown and once as real', () => {
    const r = topN([{ order: ['a'], golden: ['G1', 'G2'], matches: [{ golden: 'G1', candidate: 'a' }, { golden: 'G2', candidate: 'a' }] }], 1);
    expect(r).toMatchObject({ shown: 1, real: 1, goldensFound: 2 });
  });
});

describe('auc', () => {
  it('is 1 when every real finding outranks every false one, 0.5 for ties, 0 when reversed', () => {
    expect(auc([{ score: 90, real: true }, { score: 10, real: false }])).toBe(1);
    expect(auc([{ score: 50, real: true }, { score: 50, real: false }])).toBe(0.5);
    expect(auc([{ score: 10, real: true }, { score: 90, real: false }])).toBe(0);
  });

  it('is NaN without both real and false findings', () => {
    expect(auc([{ score: 1, real: true }])).toBeNaN();
  });
});

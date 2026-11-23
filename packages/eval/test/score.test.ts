import { describe, expect, it } from 'vitest';
import { matchCase, scoreRun } from '../src/score.js';
import { GoldenCaseSchema, type GoldenCase } from '../src/golden.js';

const issue = (id: string, file: string, line: number, endLine = line) => ({ id, file, line, endLine, severity: 'high' as const, description: id });
const pred = (file: string, startLine: number, endLine = startLine) => ({ file, startLine, endLine, claim: 'x' });

function goldenCase(id: string, issues: GoldenCase['issues']): GoldenCase {
  return { id, repo: 'o/r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), split: 'tuning', labelSource: 'synthetic', issues };
}

describe('matchCase', () => {
  it('matches within the line tolerance and in the same file only', () => {
    const r = matchCase([issue('i1', 'a.ts', 10)], [pred('a.ts', 14), pred('b.ts', 10)], 5);
    expect(r.matches).toEqual([{ issueId: 'i1', predictionIndex: 0 }]);
    expect(r.falsePositives).toEqual([1]);
    expect(r.missed).toEqual([]);
  });

  it('treats ranges as overlapping at distance zero', () => {
    const r = matchCase([issue('i1', 'a.ts', 10, 30)], [pred('a.ts', 1, 12)], 0);
    expect(r.matches).toHaveLength(1);
  });

  it('matches one to one, preferring the closest pairs', () => {
    const r = matchCase([issue('i1', 'a.ts', 10), issue('i2', 'a.ts', 13)], [pred('a.ts', 13), pred('a.ts', 11), pred('a.ts', 12)], 5);
    expect(r.matches).toEqual([
      { issueId: 'i2', predictionIndex: 0 },
      { issueId: 'i1', predictionIndex: 1 },
    ]);
    expect(r.falsePositives).toEqual([2]);
  });

  it('reports missed issues', () => {
    expect(matchCase([issue('i1', 'a.ts', 10)], [pred('a.ts', 100)], 5).missed).toEqual(['i1']);
  });
});

describe('scoreRun', () => {
  it('computes micro-averaged precision, recall and F1 across cases', () => {
    const cases = [goldenCase('c1', [issue('i1', 'a.ts', 10), issue('i2', 'a.ts', 50)]), goldenCase('c2', [issue('i3', 'b.ts', 5)])];
    const r = scoreRun(cases, { c1: [pred('a.ts', 10), pred('a.ts', 200)], c2: [pred('b.ts', 5)] }, { tolerance: 5 });
    expect(r.totals).toMatchObject({ truePositives: 2, falsePositives: 1, falseNegatives: 1 });
    expect(r.totals.precision).toBeCloseTo(2 / 3);
    expect(r.totals.recall).toBeCloseTo(2 / 3);
    expect(r.totals.f1).toBeCloseTo(2 / 3);
  });

  it('reports precision as null when there are no predictions, and lists cases with no prediction entry', () => {
    const r = scoreRun([goldenCase('c1', [issue('i1', 'a.ts', 1)])], {}, { tolerance: 5 });
    expect(r.totals.precision).toBeNull();
    expect(r.totals.recall).toBe(0);
    expect(r.totals.f1).toBeNull();
    expect(r.missingPredictions).toEqual(['c1']);
  });

  it('ignores predictions for unknown cases but reports them', () => {
    const r = scoreRun([goldenCase('c1', [])], { c1: [], zz: [pred('a.ts', 1)] }, { tolerance: 5 });
    expect(r.unknownCases).toEqual(['zz']);
    expect(r.totals.falsePositives).toBe(0);
  });

  it('can restrict scoring to one split', () => {
    const held = { ...goldenCase('c2', [issue('i2', 'a.ts', 1)]), split: 'heldout' as const };
    const r = scoreRun([goldenCase('c1', [issue('i1', 'a.ts', 1)]), held], { c1: [pred('a.ts', 1)], c2: [] }, { tolerance: 5, split: 'heldout' });
    expect(r.cases.map((c) => c.id)).toEqual(['c2']);
    expect(r.totals.recall).toBe(0);
  });
});

describe('GoldenCaseSchema', () => {
  it('rejects issue ids that repeat within a case', () => {
    const c = goldenCase('c1', [issue('i1', 'a.ts', 1), issue('i1', 'a.ts', 9)]);
    expect(GoldenCaseSchema.safeParse(c).success).toBe(false);
  });

  it('rejects SHAs that are not full hex commits', () => {
    expect(GoldenCaseSchema.safeParse({ ...goldenCase('c1', []), baseSha: 'main' }).success).toBe(false);
  });
});

describe('PredictionSchema', () => {
  it('rejects inverted ranges', async () => {
    const { PredictionSchema } = await import('../src/golden.js');
    expect(PredictionSchema.safeParse({ file: 'a.ts', startLine: 1000, endLine: 1, claim: 'x' }).success).toBe(false);
  });
});

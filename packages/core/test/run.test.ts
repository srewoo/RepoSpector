import { describe, expect, it } from 'vitest';
import { ReviewRun, RunStateError } from '../src/run.js';
import type { LineSource } from '../src/evidence.js';
import { validFinding } from './fixtures.js';

const source: LineSource = {
  lineCount: (p) => ({ 'src/a.ts': 20, 'src/b.ts': 5 } as Record<string, number>)[p],
};
const cite = { file: 'src/a.ts', startLine: 3, endLine: 3 };

function newRun() {
  return new ReviewRun('run1', ['logic', 'security'], source);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RunStateError) return e.code;
    throw e;
  }
  return undefined;
}

describe('ReviewRun', () => {
  it('accepts findings with real evidence and rejects ones that cite missing lines or files', () => {
    const run = newRun();
    const r = run.submitFindings('logic', [
      validFinding,
      { ...validFinding, evidence: [{ file: 'src/a.ts', startLine: 19, endLine: 25 }] },
      { ...validFinding, file: 'src/missing.ts', evidence: [{ file: 'src/missing.ts', startLine: 1, endLine: 1 }] },
      { nonsense: true },
    ]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ id: 'f1', specialist: 'logic' });
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(r.rejected[0]?.reason).toMatch(/src\/a\.ts:19-25.*20 lines/);
    expect(r.rejected[1]?.reason).toMatch(/does not exist/);
  });

  it('refuses findings from a specialist that was not planned', () => {
    expect(codeOf(() => newRun().submitFindings('duplication', [validFinding]))).toBe('unknown-specialist');
  });

  it('refuses verification until every planned specialist has submitted', () => {
    const run = newRun();
    run.submitFindings('logic', [validFinding]);
    expect(codeOf(() => run.startVerification())).toBe('specialists-pending');
    expect(run.state().pendingSpecialists).toEqual(['security']);
    run.submitFindings('security', []);
    expect(run.startVerification().findings).toHaveLength(1);
  });

  it('refuses new findings once verification has started', () => {
    const run = newRun();
    run.submitFindings('logic', []);
    run.submitFindings('security', []);
    run.startVerification();
    expect(codeOf(() => run.submitFindings('logic', [validFinding]))).toBe('wrong-stage');
  });

  it('refuses to finalize before verification, without a verdict for every finding, or with a bad batch id', () => {
    const run = newRun();
    run.submitFindings('logic', [validFinding, { ...validFinding, startLine: 10, endLine: 10, claim: 'other' }]);
    run.submitFindings('security', []);
    expect(codeOf(() => newRun().finalize('x', []))).toBe('wrong-stage');
    const { batchId } = run.startVerification();
    expect(codeOf(() => run.finalize('wrong', []))).toBe('bad-batch');
    expect(codeOf(() => run.finalize(batchId, [{ findingId: 'f1', keep: true, reason: 'ok', citation: cite }]))).toBe(
      'missing-verdicts',
    );
  });

  it('refuses verdicts that cite code that does not exist or name unknown findings', () => {
    const run = newRun();
    run.submitFindings('logic', [validFinding]);
    run.submitFindings('security', []);
    const { batchId } = run.startVerification();
    const badCite = { findingId: 'f1', keep: false, reason: 'x', citation: { file: 'src/a.ts', startLine: 99, endLine: 99 } };
    expect(codeOf(() => run.finalize(batchId, [badCite]))).toBe('invalid-verdict');
    const unknown = { findingId: 'f9', keep: true, reason: 'x', citation: cite };
    expect(codeOf(() => run.finalize(batchId, [unknown]))).toBe('invalid-verdict');
  });

  it('finalizes once, applying verdicts and the judge', () => {
    const run = newRun();
    run.submitFindings('logic', [validFinding, { ...validFinding, startLine: 10, endLine: 10, claim: 'other' }]);
    run.submitFindings('security', []);
    const { batchId } = run.startVerification();
    const result = run.finalize(batchId, [
      { findingId: 'f1', keep: true, reason: 'ok', citation: cite },
      { findingId: 'f2', keep: false, reason: 'guarded', citation: cite },
    ]);
    expect(result.kept.map((f) => [f.id, f.status])).toEqual([
      ['f1', 'verified'],
      ['f2', 'suspected'],
    ]);
    expect(run.state().stage).toBe('finalized');
    expect(codeOf(() => run.finalize(batchId, []))).toBe('wrong-stage');
  });

  it('caps the number of findings per specialist submission', () => {
    const run = newRun();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...validFinding, claim: `c${i}` }));
    expect(codeOf(() => run.submitFindings('logic', many))).toBe('too-many-findings');
  });
});

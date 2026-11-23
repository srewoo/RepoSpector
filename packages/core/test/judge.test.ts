import { describe, expect, it } from 'vitest';
import { judge } from '../src/judge.js';
import type { Finding, VerdictInput } from '../src/finding.js';

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    specialist: 'logic',
    fingerprint: id,
    file: 'a.ts',
    startLine: 10,
    endLine: 12,
    severity: 'medium',
    category: 'logic',
    reasoning: 'r',
    claim: `claim ${id}`,
    evidence: [{ file: 'a.ts', startLine: 10, endLine: 12 }],
    confidence: 0.8,
    ...over,
  };
}
const cite = { file: 'a.ts', startLine: 10, endLine: 10 };
const keep = (findingId: string): VerdictInput => ({ findingId, keep: true, reason: 'confirmed', citation: cite });
const drop = (findingId: string): VerdictInput => ({ findingId, keep: false, reason: 'guarded', citation: cite });

describe('judge', () => {
  it('keeps refuted findings as suspected, after verified ones, with the reason', () => {
    const r = judge(
      [finding('f2', { severity: 'high', startLine: 50, endLine: 50 }), finding('f1', { severity: 'low' })],
      [keep('f1'), drop('f2')],
    );
    expect(r.kept.map((f) => [f.id, f.status])).toEqual([
      ['f1', 'verified'],
      ['f2', 'suspected'],
    ]);
    expect(r.kept[1]?.suspectedBecause).toBe('verifier: guarded');
    expect(r.dropped).toEqual([]);
  });

  it('keeps low-confidence findings as suspected', () => {
    const r = judge([finding('f1', { confidence: 0.3 })], [keep('f1')], { minConfidence: 0.5 });
    expect(r.kept[0]).toMatchObject({ status: 'suspected', suspectedBecause: 'confidence 0.3' });
  });

  it('drops suspected findings only when asked to', () => {
    const r = judge(
      [finding('f1', { confidence: 0.3 }), finding('f2', { startLine: 50, endLine: 50 })],
      [keep('f1'), drop('f2')],
      { minConfidence: 0.5, dropSuspected: true },
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((d) => [d.id, d.reason])).toEqual([
      ['f1', 'below-threshold'],
      ['f2', 'refuted'],
    ]);
  });

  it('prefers a verified finding over a suspected duplicate of it', () => {
    const r = judge([finding('f1', { severity: 'high' }), finding('f2', { severity: 'low', startLine: 11, endLine: 11 })], [drop('f1'), keep('f2')]);
    expect(r.kept.map((f) => f.id)).toEqual(['f2']);
    expect(r.dropped).toEqual([{ id: 'f1', reason: 'duplicate', detail: 'duplicate of f2' }]);
  });

  it('merges overlapping findings in the same category, keeping the stronger one', () => {
    const r = judge(
      [
        finding('f1', { severity: 'low' }),
        finding('f2', { severity: 'high', startLine: 11, endLine: 11 }),
        finding('f3', { fingerprint: 'f1', startLine: 90, endLine: 90 }),
        finding('f4', { category: 'security', startLine: 11, endLine: 11 }),
      ],
      ['f1', 'f2', 'f3', 'f4'].map(keep),
    );
    expect(r.kept.map((f) => f.id).sort()).toEqual(['f2', 'f3', 'f4']);
    expect(r.dropped.filter((d) => d.reason === 'duplicate').map((d) => d.id)).toEqual(['f1']);
  });

  it('sorts by severity then confidence', () => {
    const r = judge(
      [
        finding('a', { severity: 'low', startLine: 1, endLine: 1 }),
        finding('b', { severity: 'high', confidence: 0.6, startLine: 20, endLine: 20 }),
        finding('c', { severity: 'high', confidence: 0.9, startLine: 40, endLine: 40 }),
      ],
      ['a', 'b', 'c'].map(keep),
    );
    expect(r.kept.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });

  it('marks confidence as uncalibrated when no calibration table is given', () => {
    const r = judge([finding('f1')], [keep('f1')]);
    expect(r.kept[0]?.expectedPrecision).toBeNull();
  });

  it('uses a calibration table when given, and thresholds on expected precision', () => {
    const calibration = { expectedPrecision: (_c: string, conf: number) => (conf >= 0.7 ? 0.9 : 0.4) };
    const r = judge(
      [finding('f1', { confidence: 0.8 }), finding('f2', { confidence: 0.6, startLine: 60, endLine: 60 })],
      [keep('f1'), keep('f2')],
      { calibration, minExpectedPrecision: 0.5 },
    );
    expect(r.kept.map((f) => [f.id, f.expectedPrecision, f.status])).toEqual([
      ['f1', 0.9, 'verified'],
      ['f2', 0.4, 'suspected'],
    ]);
  });
});

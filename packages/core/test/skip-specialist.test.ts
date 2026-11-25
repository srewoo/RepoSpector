import { describe, expect, it } from 'vitest';
import type { LineSource } from '../src/evidence.js';
import { ReviewRun, RunStateError } from '../src/run.js';
import { validFinding } from './fixtures.js';

const source: LineSource = { lineCount: (p) => (p === 'src/a.ts' ? 20 : undefined) };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RunStateError) return e.code;
    throw e;
  }
  return undefined;
}

describe('ReviewRun.skipSpecialist', () => {
  it('lets a run verify when a stopped specialist is recorded as skipped, and reports it', () => {
    const run = new ReviewRun('r', ['logic', 'security'], source);
    run.submitFindings('logic', [validFinding]);
    expect(codeOf(() => run.startVerification())).toBe('specialists-pending');
    run.skipSpecialist('security', 'stopped by a safety safeguard');
    expect(run.state().skippedSpecialists).toEqual([{ specialist: 'security', reason: 'stopped by a safety safeguard' }]);
    expect(run.startVerification().findings).toHaveLength(1);
  });

  it('refuses unknown specialists, ones that already submitted, and skips after review closed', () => {
    const run = new ReviewRun('r', ['logic'], source);
    expect(codeOf(() => run.skipSpecialist('tests', 'x'))).toBe('unknown-specialist');
    run.submitFindings('logic', []);
    expect(codeOf(() => run.skipSpecialist('logic', 'x'))).toBe('wrong-stage');
    run.startVerification();
    expect(codeOf(() => run.skipSpecialist('logic', 'x'))).toBe('wrong-stage');
  });

  it('counts a skipped specialist as covered again if it submits after all', () => {
    const run = new ReviewRun('r', ['logic'], source);
    run.skipSpecialist('logic', 'timed out');
    run.submitFindings('logic', []);
    expect(run.state().skippedSpecialists).toEqual([]);
  });
});

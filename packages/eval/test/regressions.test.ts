import { describe, expect, it } from 'vitest';
import { parseRegressionFile } from '../src/regressions.js';

const good = {
  pr_title: 'Add retry to fetch',
  url: 'https://github.com/o/r/pull/12',
  language: 'go',
  merged_at: '2025-09-01T10:00:00Z',
  changed_lines: 120,
  comments: [{ comment: 'Retry loop in client.go never resets the backoff, so the second request waits forever.', severity: 'High' }],
  evidence: {
    fix_url: 'https://github.com/o/r/pull/40',
    fix_kind: 'fix',
    quote: 'This fixes the hang introduced in #12.',
    original_locations: [{ file: 'client.go', lines: '10-20' }],
  },
};

describe('parseRegressionFile', () => {
  it('turns valid cases into benchmark cases, keeping the evidence', () => {
    const [c] = parseRegressionFile([good]);
    expect(c).toMatchObject({ id: good.url, repo: 'o/r', number: 12, title: good.pr_title, golden: [{ severity: 'High' }] });
    expect(c?.evidence.fix_url).toBe('https://github.com/o/r/pull/40');
  });

  it.each([
    ['merged before the window', { merged_at: '2025-06-30T23:59:59Z' }],
    ['merged after the window', { merged_at: '2026-11-01T00:00:00Z' }],
    ['too large', { changed_lines: 1501 }],
    ['two golden comments', { comments: [good.comments[0], good.comments[0]] }],
    ['unknown severity', { comments: [{ comment: 'x', severity: 'Severe' }] }],
    ['fix is the same PR', { evidence: { ...good.evidence, fix_url: good.url } }],
    ['unsupported language', { language: 'rust' }],
    ['unknown field', { extra: 1 }],
  ])('rejects a case that is %s', (_, patch) => {
    expect(() => parseRegressionFile([{ ...good, ...patch }])).toThrow();
  });

  it('rejects duplicate PRs across the set', () => {
    expect(() => parseRegressionFile([good, good])).toThrow(/duplicate/);
  });
});

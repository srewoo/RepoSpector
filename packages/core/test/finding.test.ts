import { describe, expect, it } from 'vitest';
import { FindingInputSchema, VerdictInputSchema, isSafeRepoPath } from '../src/finding.js';
import { fingerprint, normalizeClaim } from '../src/fingerprint.js';
import { validFinding } from './fixtures.js';


describe('FindingInputSchema', () => {
  it('accepts a valid finding', () => {
    expect(FindingInputSchema.safeParse(validFinding).success).toBe(true);
  });

  it.each([
    ['unknown fields', { ...validFinding, extra: 1 }],
    ['endLine before startLine', { ...validFinding, startLine: 5, endLine: 4 }],
    ['no evidence', { ...validFinding, evidence: [] }],
    ['confidence above 1', { ...validFinding, confidence: 1.2 }],
    ['unknown severity', { ...validFinding, severity: 'critical' }],
    ['path traversal', { ...validFinding, file: '../etc/passwd' }],
    ['absolute path', { ...validFinding, file: '/etc/passwd' }],
    ['line 0', { ...validFinding, startLine: 0 }],
  ])('rejects %s', (_label, input) => {
    expect(FindingInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('VerdictInputSchema', () => {
  it('requires a code citation for both keep and drop', () => {
    const base = { findingId: 'f1', keep: false, reason: 'guarded on line 2' };
    expect(VerdictInputSchema.safeParse(base).success).toBe(false);
    expect(
      VerdictInputSchema.safeParse({ ...base, citation: { file: 'a.ts', startLine: 2, endLine: 2 } }).success,
    ).toBe(true);
  });
});

describe('isSafeRepoPath', () => {
  it.each(['a.ts', 'src/a b.ts', '.github/x.yml'])('allows %s', (p) => expect(isSafeRepoPath(p)).toBe(true));
  it.each(['', '/a', '../a', 'a/../../b', 'a\\b', 'C:/x', 'a\0b', './a'])('rejects %s', (p) =>
    expect(isSafeRepoPath(p)).toBe(false),
  );
});

describe('fingerprint', () => {
  it('is stable when only numbers, case and punctuation change in the claim', () => {
    const a = fingerprint({ file: 'a.ts', category: 'logic', claim: 'Off-by-one on line 12!' });
    const b = fingerprint({ file: 'a.ts', category: 'logic', claim: 'off by one on line 40' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs by file, category and symbol', () => {
    const base = { file: 'a.ts', category: 'logic' as const, claim: 'x' };
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, file: 'b.ts' })).not.toBe(fp);
    expect(fingerprint({ ...base, category: 'security' })).not.toBe(fp);
    expect(fingerprint({ ...base, symbol: 'f' })).not.toBe(fp);
  });

  it('normalizes claims', () => {
    expect(normalizeClaim('  Off-by-one   on LINE 12 ')).toBe('off by one on line');
  });
});

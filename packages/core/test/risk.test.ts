import { describe, expect, it } from 'vitest';
import { assessRisk, isSkippablePath } from '../src/risk.js';
import type { DiffFile } from '../src/diff.js';

function file(path: string, added: number, removed = 0): DiffFile {
  return {
    path,
    oldPath: path,
    status: 'modified',
    binary: false,
    hunks: [],
    addedLines: Array.from({ length: added }, (_, i) => i + 1),
    removedCount: removed,
  };
}

describe('isSkippablePath', () => {
  it.each(['package-lock.json', 'yarn.lock', 'a/pnpm-lock.yaml', 'go.sum', 'dist/x.js', 'x.min.js', 'gen/foo.pb.go', 'a/__snapshots__/x.snap'])(
    'skips %s',
    (p) => expect(isSkippablePath(p)).toBe(true),
  );
  it.each(['src/lock.ts', 'package.json', 'src/dist.ts'])('keeps %s', (p) => expect(isSkippablePath(p)).toBe(false));
});

describe('assessRisk', () => {
  it('skips lockfile-only changes', () => {
    const r = assessRisk([file('package-lock.json', 300)]);
    expect(r.tier).toBe('skip');
    expect(r.reviewable).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'package-lock.json', reason: 'lockfile or generated' }]);
  });

  it('rates a small change as trivial', () => {
    expect(assessRisk([file('src/a.ts', 5, 2)]).tier).toBe('trivial');
  });

  it('rates a medium change as standard', () => {
    expect(assessRisk([file('src/a.ts', 80, 10)]).tier).toBe('standard');
  });

  it('rates a small change to a sensitive path as high and says why', () => {
    const r = assessRisk([file('src/auth/session.ts', 3)]);
    expect(r.tier).toBe('high');
    expect(r.reasons.join(' ')).toMatch(/src\/auth\/session\.ts/);
  });

  it('rates a large change as high', () => {
    expect(assessRisk([file('src/a.ts', 450, 100)]).tier).toBe('high');
  });

  it('skips binary and deleted files from review but lists them', () => {
    const bin = { ...file('a.png', 0), binary: true };
    const del = { ...file('old.ts', 0, 10), status: 'deleted' as const };
    const r = assessRisk([bin, del, file('src/a.ts', 5)]);
    expect(r.reviewable.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(r.skipped.map((s) => s.reason)).toEqual(['binary', 'deleted']);
  });
});

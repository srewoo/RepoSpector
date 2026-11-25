import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff } from '@repospector/core';
import { describe, expect, it } from 'vitest';
import { acceptFiles, definitionNames, gitBlobId, IntakeError, neededFiles, normalizePr } from '../src/remote/intake.js';
import { MemorySource } from '../src/remote/memory-source.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function hashObject(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-blob-'));
  writeFileSync(join(dir, 'f'), content);
  return execFileSync('git', ['hash-object', join(dir, 'f')], { encoding: 'utf8' }).trim();
}

describe('normalizePr', () => {
  it('builds a unified diff from per-file patches (added, modified, renamed, deleted)', () => {
    const pr = normalizePr({
      headSha: HEAD.toUpperCase(),
      baseSha: BASE,
      title: 'Fix totals',
      files: [
        { path: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;' },
        { path: 'src/cart.ts', status: 'modified', patch: '@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;\n const y = 3;\n' },
        { path: 'src/moved.ts', previousPath: 'src/old.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-a\n+b\n' },
        { path: 'src/gone.ts', status: 'deleted' },
        { path: 'img/logo.png', status: 'modified' },
      ],
    });
    expect(pr.headSha).toBe(HEAD);
    const files = parseUnifiedDiff(pr.diff);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/new.ts', 'added'],
      ['src/cart.ts', 'modified'],
      ['src/moved.ts', 'renamed'],
      ['src/gone.ts', 'deleted'],
    ]);
    expect(files[0]?.addedLines).toEqual([1, 2]);
    expect(pr.noPatch).toEqual(['img/logo.png']);
    expect(neededFiles(pr.diff)).toEqual(['src/new.ts', 'src/cart.ts', 'src/moved.ts']);
  });

  it('accepts a whole unified diff instead of files', () => {
    const diff = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a = 1\n+a = compute(2)\n';
    const pr = normalizePr({ headSha: HEAD, baseSha: BASE, diff });
    expect(pr.diff).toBe(diff);
    expect(definitionNames(pr.diff)).toContain('compute');
  });

  it('refuses short commit ids, both or neither of diff/files, unsafe paths and patches with headers', () => {
    expect(() => normalizePr({ headSha: 'abc123', baseSha: BASE, diff: '' })).toThrow(IntakeError);
    expect(() => normalizePr({ headSha: HEAD, baseSha: BASE })).toThrow(/exactly one/);
    expect(() => normalizePr({ headSha: HEAD, baseSha: BASE, diff: '', files: [] })).toThrow(/exactly one/);
    expect(() => normalizePr({ headSha: HEAD, baseSha: BASE, files: [{ path: '../etc/passwd', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }] })).toThrow(/unsafe path/);
    expect(() => normalizePr({ headSha: HEAD, baseSha: BASE, files: [{ path: 'a.ts', status: 'modified', patch: '--- a/a.ts\n+++ b/a.ts\n@@' }] })).toThrow(/start with "@@"/);
    expect(() => normalizePr({ headSha: HEAD, baseSha: BASE, diff: 'diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n' })).toThrow(/unsafe path/);
  });
});

describe('acceptFiles', () => {
  it('matches git hash-object', () => {
    expect(gitBlobId(Buffer.from('hello\n'))).toBe(hashObject('hello\n'));
  });

  it('stores files whose content matches the blob id, and marks them verified', () => {
    const src = new MemorySource();
    const content = 'export function total() {\n  return 1;\n}\n';
    const r = acceptFiles(src, [{ path: 'src/a.ts', content, blobSha: hashObject(content) }]);
    expect(r.stored).toEqual([{ path: 'src/a.ts', lines: 3, verified: true }]);
    expect(src.snippet('src/a.ts', 2, 2)).toBe('2:   return 1;');
  });

  it('repairs a final newline the MCP tool dropped, but refuses any other change', () => {
    const src = new MemorySource();
    const content = 'a\nb\n';
    const blob = hashObject(content);
    expect(acceptFiles(src, [{ path: 'x.ts', content: 'a\nb', blobSha: blob }]).stored).toHaveLength(1);
    expect(src.lineCount('x.ts')).toBe(2);
    const r = acceptFiles(src, [{ path: 'y.ts', content: 'a\nB\n', blobSha: blob }]);
    expect(r.refused[0]?.reason).toMatch(/does not match blob/);
  });

  it('decodes base64, and refuses secrets, binaries, unsafe paths and replacing a file', () => {
    const src = new MemorySource();
    const r = acceptFiles(src, [
      { path: 'b.ts', content: Buffer.from('const b = 1;\n').toString('base64'), encoding: 'base64' },
      { path: 'config/.env', content: 'TOKEN=x\n' },
      { path: 'bin.dat', content: 'a\u0000b' },
      { path: '../up.ts', content: 'x' },
      { path: 'b.ts', content: 'const b = 2;\n' },
    ]);
    expect(r.stored.map((s) => [s.path, s.verified])).toEqual([['b.ts', false]]);
    expect(r.refused.map((x) => x.reason)).toEqual([
      'possible secrets: never sent to a model',
      'binary',
      'unsafe path',
      'already provided (files cannot be replaced within a review)',
    ]);
    expect(src.lines('b.ts')).toEqual(['const b = 1;']);
  });
});

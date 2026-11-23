import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherContext } from '../src/context.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-ctx-'));
  git(dir, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'head');
  return dir;
}

const DIFF = `diff --git a/src/svc.py b/src/svc.py
--- a/src/svc.py
+++ b/src/svc.py
@@ -1,2 +1,2 @@
-def fetch_scopes(org):
+def fetch_scopes(org, user):
     return []
`;

describe('gatherContext', () => {
  it('finds callers of a changed function in other files with surrounding lines', async () => {
    const dir = repo({
      'src/svc.py': 'def fetch_scopes(org, user):\n    return []\n',
      'src/api.py': 'import svc\n\n\ndef handler(org):\n    return svc.fetch_scopes(org)\n',
      'src/unrelated.py': 'x = 1\n',
    });
    const ctx = await gatherContext(DIFF, dir);
    expect(ctx.symbols.map((s) => s.name)).toEqual(['fetch_scopes']);
    expect(ctx.pack.hits).toEqual([expect.objectContaining({ file: 'src/api.py', line: 5, symbol: 'fetch_scopes' })]);
    expect(ctx.pack.text).toContain('def handler(org):');
    expect(ctx.pack.text).toContain('svc.fetch_scopes(org)');
  });

  it('skips symbols with too many hits to be useful', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `fetch_scopes(${i})`).join('\n');
    const dir = repo({ 'src/svc.py': 'def fetch_scopes(org, user):\n    return []\n', 'src/many.py': many });
    const ctx = await gatherContext(DIFF, dir, { maxHitsPerSymbol: 10 });
    expect(ctx.pack.hits).toEqual([]);
    expect(ctx.tooCommon).toEqual(['fetch_scopes']);
  });

  it('returns an empty pack when the diff defines nothing', async () => {
    const dir = repo({ 'a.txt': 'x\n' });
    const ctx = await gatherContext('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', dir);
    expect(ctx.pack.text).toBe('');
  });
});

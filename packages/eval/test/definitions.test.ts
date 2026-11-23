import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefinitionsPrompt, DEFINITIONS_ADDENDUM, gatherDefinitions } from '../src/definitions.js';
import { BASELINE_PROMPT } from '../src/baseline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-defs-'));
  git(dir, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'head');
  return dir;
}

const DIFF = `diff --git a/src/api.py b/src/api.py
--- a/src/api.py
+++ b/src/api.py
@@ -1,1 +1,2 @@
 import perms
+    perms.get_or_create_resource(client_id, server)
`;

describe('gatherDefinitions', () => {
  it('returns the definition and body of a function the diff calls, not its other uses', async () => {
    const dir = repo({
      'src/api.py': 'import perms\n    perms.get_or_create_resource(client_id, server)\n',
      'src/perms.py': 'x = 1\n\ndef get_or_create_resource(name, server):\n    return find_by_name(name)\n',
      'src/other.py': 'get_or_create_resource(a, b)\n',
      'tests/test_perms.py': 'def get_or_create_resource(a, b):\n    pass\n',
    });
    const d = await gatherDefinitions(DIFF, dir);
    expect(d.names).toEqual(['get_or_create_resource']);
    expect(d.found.map((f) => `${f.file}:${f.line}`)).toEqual(['src/perms.py:3']);
    expect(d.text).toContain('return find_by_name(name)');
    expect(d.text).not.toContain('src/other.py');
  });

  it('skips names with too many definitions to be sure which one is called', async () => {
    const files: Record<string, string> = { 'src/api.py': 'x\n' };
    for (let i = 0; i < 5; i++) files[`src/m${i}.py`] = 'def get_or_create_resource(a):\n    pass\n';
    const d = await gatherDefinitions(DIFF, repo(files));
    expect(d.found).toEqual([]);
    expect(d.ambiguous).toEqual(['get_or_create_resource']);
  });
});

describe('buildDefinitionsPrompt', () => {
  it('is the baseline prompt plus the addendum, definitions before the diff', () => {
    const p = buildDefinitionsPrompt('T', 'DIFF', 'DEFS');
    expect(p.startsWith(`${BASELINE_PROMPT}\n\n${DEFINITIONS_ADDENDUM}`)).toBe(true);
    expect(p.indexOf('<definitions>\nDEFS\n</definitions>')).toBeLessThan(p.indexOf('<diff>\nDIFF\n</diff>'));
  });
});

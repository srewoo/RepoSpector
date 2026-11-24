import { describe, expect, it } from 'vitest';
import { gatherRepoContext, type RepoContextDeps } from '../src/pipeline/repo-context.js';

const SHA = 'a'.repeat(40);
const DIFF = 'diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,1 +1,3 @@\n a\n+const t = computeTotal(items, tax);\n+saveOrder(t);\n';

function deps(over: Partial<RepoContextDeps> = {}): RepoContextDeps & { jobs: unknown[]; reads: string[] } {
  const jobs: unknown[] = [];
  const reads: string[] = [];
  return {
    jobs,
    reads,
    target: { kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
    apiBase: 'https://api.github.com',
    hostToken: 'ghp_x',
    api: { get: async () => JSON.stringify({ private: false, size: 2048 }), post: async () => '' },
    fileAt: async (path) => (reads.push(path), path === 'src/math.ts' ? 'export function computeTotal(items, rate) {\n  return items * rate;\n}\n' : 'x'),
    locate: async (job) => (jobs.push(job), { type: 'located', reqId: 'r', source: 'download', files: 120, definitions: { found: [{ name: 'computeTotal', file: 'src/math.ts', line: 1 }], ambiguous: [], missing: ['saveOrder'] } }),
    ...over,
  };
}

describe('gatherRepoContext', () => {
  it('locates what the diff calls in the whole repository, then reads only those files', async () => {
    const d = deps();
    const c = await gatherRepoContext({ diff: DIFF, headSha: SHA }, d);
    expect(d.jobs[0]).toMatchObject({ repo: 'github.com/o/r', sha: SHA, archiveUrl: `https://api.github.com/repos/o/r/tarball/${SHA}`, locate: { names: expect.arrayContaining(['computeTotal', 'saveOrder']) } });
    // Public repository: no token on the archive download.
    expect(d.jobs[0]).not.toHaveProperty('token');
    expect(d.reads).toEqual(['src/math.ts']);
    expect(c).toEqual({ text: expect.stringContaining('export function computeTotal(items, rate)'), definitions: 1, indexedFiles: 120 });
  });

  it('sends the token with the archive only for a private repository', async () => {
    const d = deps({ api: { get: async () => JSON.stringify({ private: true }), post: async () => '' } });
    await gatherRepoContext({ diff: DIFF, headSha: SHA }, d);
    expect(d.jobs[0]).toMatchObject({ token: 'ghp_x' });
  });

  it('does nothing (no download) when the diff calls nothing', async () => {
    const d = deps();
    expect(await gatherRepoContext({ diff: 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n', headSha: SHA }, d)).toEqual({ text: '', definitions: 0, indexedFiles: 0 });
    expect(d.jobs).toEqual([]);
  });

  it('skips files that cannot be read and passes indexing errors up (the review then uses the diff only)', async () => {
    const unreadable = deps({ fileAt: async () => { throw new Error('404'); } });
    expect((await gatherRepoContext({ diff: DIFF, headSha: SHA }, unreadable)).definitions).toBe(0);
    const failing = deps({ locate: async () => { throw new Error('the repository download is larger than 300 MB, so it was stopped'); } });
    await expect(gatherRepoContext({ diff: DIFF, headSha: SHA }, failing)).rejects.toThrow(/larger than 300 MB/);
  });
});

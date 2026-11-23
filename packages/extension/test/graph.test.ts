import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createExtractor, type ApiClient, type Extractor, type TreeSitterRuntime } from '@repospector/core';
import { archivePlan, GITHUB_CODELOAD } from '../src/graph/archive.js';
import { gitBlobId, KEEP_GRAPHS, memoryCache } from '../src/graph/cache.js';
import { buildIndex, MAX_CHANGED_FILES, NoSavedIndex, type IndexJob } from '../src/graph/index-archive.js';

// The real tree-sitter runtime and grammars, loaded the Node way (the extension worker loads the same files).
const require = createRequire(import.meta.url);
const WASM = dirname(require.resolve('@vscode/tree-sitter-wasm'));
let real: Promise<Extractor> | undefined;
function realExtractor(): Promise<Extractor> {
  real ??= (async () => {
    const ts = require('@vscode/tree-sitter-wasm') as TreeSitterRuntime & { Parser: { init(o: { locateFile: (f: string) => string }): Promise<void> } };
    await ts.Parser.init({ locateFile: (f) => join(WASM, f) });
    return createExtractor(ts, async (f) => join(WASM, f));
  })();
  return real;
}
/** Counts which files were actually parsed. */
async function counting() {
  const inner = await realExtractor();
  const parsed: string[] = [];
  return { parsed, extractor: { extractSymbols: (p: string, s: string) => (parsed.push(p), inner.extractSymbols(p, s)) } satisfies Extractor };
}

/** A small repo with two commits; the second changes only src/pay.py. Serves archives, trees and blobs like GitHub. */
function twoCommits() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-graph-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { maxBuffer: 1 << 26 });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
  writeFileSync(join(dir, 'src/cart.py'), 'class Cart:\n    def total(self, items):\n        s = 0\n        for i in items:\n            s += i\n        return s\n');
  writeFileSync(join(dir, 'src/pay.py'), 'from cart import Cart\n\ndef pay(c):\n    return c.total([1, 2])\n\nclass GiftCart(Cart):\n    pass\n');
  writeFileSync(join(dir, 'node_modules/x/index.js'), 'function total() {}\ntotal();\n');
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
  const one = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(join(dir, 'src/pay.py'), 'from cart import Cart\n\ndef pay(c):\n    return c.total([1, 2])\n\ndef refund(c):\n    return -c.total([3])\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');
  const two = git('rev-parse', 'HEAD').toString().trim();
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const tarball = /\/tarball\/([0-9a-f]{40})$/.exec(url);
    if (tarball) return new Response(gzipSync(git('archive', '--format=tar', '--prefix=o-r-x/', tarball[1] ?? '')));
    const tree = /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(url);
    if (tree) {
      const entries = git('ls-tree', '-r', '-l', tree[1] ?? '').toString().trim().split('\n').map((l) => {
        const [meta, path] = l.split('\t');
        const [, type, sha, size] = (meta ?? '').trim().split(/\s+/);
        return { path, type, sha, size: Number(size) };
      });
      return Response.json({ truncated: false, tree: entries });
    }
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(url);
    if (blob) return new Response(git('cat-file', 'blob', blob[1] ?? ''));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { one, two, fetchImpl, calls };
}

const API = 'https://api.github.com/repos/o/r';
const job = (sha: string, over: Partial<IndexJob> = {}): IndexJob => ({ repo: 'github.com/o/r', sha, findings: [{ id: 'f1', file: 'src/cart.py', line: 4 }, { id: 'f2', file: 'src/cart.py', line: 1 }], archiveUrl: `${API}/tarball/${sha}`, maxDownloadBytes: 10_000_000, ...over });
let clock = 1_000;
const now = () => ++clock;

describe('buildIndex with the saved index', () => {
  it('downloads and parses once; the same commit is then served from the saved index with no download', async () => {
    const r = twoCommits();
    const cache = memoryCache();
    const c1 = await counting();
    const first = await buildIndex(job(r.one), { fetch: r.fetchImpl, extractor: c1.extractor, cache, now });
    expect(first).toMatchObject({ source: 'download', files: 2, reused: 0 });
    expect(first.context.f1?.callers).toEqual([{ file: 'src/pay.py', line: 4, caller: 'pay' }]); // node_modules skipped
    expect(first.context.f2?.subtypes).toEqual([{ file: 'src/pay.py', line: 6, name: 'GiftCart' }]);
    const c2 = await counting();
    const again = await buildIndex(job(r.one), { fetch: r.fetchImpl, extractor: c2.extractor, cache, now });
    expect(again).toMatchObject({ source: 'saved', files: 2, reused: 2 });
    expect(again.context).toEqual(first.context);
    expect(c2.parsed).toEqual([]);
    expect(r.calls).toHaveLength(1); // only the first download
  });

  it('a new commit without an API token: downloads again but parses only the changed file', async () => {
    const r = twoCommits();
    const cache = memoryCache();
    await buildIndex(job(r.one), { fetch: r.fetchImpl, extractor: (await counting()).extractor, cache, now });
    const c = await counting();
    const next = await buildIndex(job(r.two), { fetch: r.fetchImpl, extractor: c.extractor, cache, now });
    expect(next).toMatchObject({ source: 'download', files: 2, reused: 1 });
    expect(c.parsed).toEqual(['src/pay.py']);
    expect(next.context.f2?.subtypes).toEqual([]); // GiftCart was removed in the new commit
    expect(next.context.f1?.callers.map((x) => x.caller)).toEqual(['pay', 'refund']);
  });

  it('a new commit with a GitHub token: lists files once and fetches only the changed one, checked by its id', async () => {
    const r = twoCommits();
    const cache = memoryCache();
    await buildIndex(job(r.one), { fetch: r.fetchImpl, extractor: (await counting()).extractor, cache, now });
    r.calls.length = 0;
    const c = await counting();
    const next = await buildIndex(job(r.two, { githubRepoApi: API, apiToken: 'tok' }), { fetch: r.fetchImpl, extractor: c.extractor, cache, now });
    expect(next).toMatchObject({ source: 'changed-files', files: 2, reused: 1 });
    expect(c.parsed).toEqual(['src/pay.py']);
    expect(r.calls.map((x) => x.url.replace(/[0-9a-f]{40}/g, '<sha>'))).toEqual([`${API}/git/trees/<sha>?recursive=1`, `${API}/git/blobs/<sha>`]);
    expect(r.calls.every((x) => x.auth === 'Bearer tok')).toBe(true);
    expect(next.context.f1?.callers.map((x) => x.caller)).toEqual(['pay', 'refund']);
  });

  it('sends the archive token only when given (private repos), never the API token', async () => {
    const r = twoCommits();
    await buildIndex(job(r.one, { apiToken: 'api' }), { fetch: r.fetchImpl, extractor: await realExtractor(), cache: memoryCache(), now });
    expect(r.calls[0]?.auth).toBeNull();
    await buildIndex(job(r.one, { token: 'priv' }), { fetch: r.fetchImpl, extractor: await realExtractor(), cache: memoryCache(), now });
    expect(r.calls[1]?.auth).toBe('Bearer priv');
  });

  it('with no saved index and no download allowed, says so instead of fetching', async () => {
    const r = twoCommits();
    await expect(buildIndex(job(r.one, { archiveUrl: undefined }), { fetch: r.fetchImpl, extractor: await realExtractor(), cache: memoryCache(), now })).rejects.toThrow(NoSavedIndex);
    expect(r.calls).toEqual([]);
  });

  it('keeps the newest commits only, and drops symbols no kept commit uses', async () => {
    const cache = memoryCache();
    for (let i = 0; i < KEEP_GRAPHS + 3; i++) await cache.putGraph({ key: `r@${i}`, repo: 'r', files: [[`f${i}.py`, `b${i}`]], skipped: 0, at: i });
    await cache.putSymbols(new Map(Array.from({ length: KEEP_GRAPHS + 3 }, (_, i) => [`b${i}`, null] as const)));
    await cache.prune(KEEP_GRAPHS);
    expect(await cache.stats()).toEqual({ graphs: KEEP_GRAPHS, blobs: KEEP_GRAPHS });
    expect(await cache.getGraph('r@0')).toBeUndefined();
    expect((await cache.latestGraph('r'))?.key).toBe(`r@${KEEP_GRAPHS + 2}`);
  });

  it('stops a download over the size limit, and explains 404 and damaged downloads', async () => {
    const r = twoCommits();
    const deps = { fetch: r.fetchImpl, extractor: await realExtractor(), cache: memoryCache(), now };
    await expect(buildIndex(job(r.one, { maxDownloadBytes: 100 }), deps)).rejects.toThrow(/larger than/);
    await expect(buildIndex(job('c'.repeat(40), { archiveUrl: `${API}/nothing` }), deps)).rejects.toThrow(/did not find this commit/);
    const bad = (async () => new Response(new Uint8Array([1, 2, 3, 4, 5]))) as unknown as typeof fetch;
    await expect(buildIndex(job(r.one), { ...deps, fetch: bad })).rejects.toThrow(/interrupted or damaged/);
  });
});

describe('gitBlobId', () => {
  it('matches git hash-object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-blob-'));
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const expected = execFileSync('git', ['hash-object', join(dir, 'a.txt')]).toString().trim();
    expect(await gitBlobId(new TextEncoder().encode('hello\n'))).toBe(expected);
  });
});

describe('archivePlan', () => {
  const api = (json: unknown): ApiClient => ({ get: async () => JSON.stringify(json), post: async () => '' });
  const sha = 'b'.repeat(40);

  it('GitHub: tarball at the reviewed commit, codeload permission, size, private flag', async () => {
    const p = await archivePlan({ kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 1 }, 'https://api.github.com', sha, api({ private: false, size: 20480 }));
    expect(p).toEqual({ url: `https://api.github.com/repos/o/r/tarball/${sha}`, private: false, approxMB: 20, origins: [GITHUB_CODELOAD] });
    expect((await archivePlan({ kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 1 }, 'https://api.github.com', sha, api({ private: true }))).private).toBe(true);
  });

  it('GitLab: archive.tar.gz at the commit; anything not public counts as private', async () => {
    const p = await archivePlan({ kind: 'gitlab', host: 'gitlab.example', project: 'g/p', iid: 3 }, 'https://gitlab.example/api/v4', sha, api({ visibility: 'internal' }));
    expect(p).toEqual({ url: `https://gitlab.example/api/v4/projects/g%2Fp/repository/archive.tar.gz?sha=${sha}`, private: true, approxMB: null, origins: [] });
  });

  it('refuses a missing or malformed commit', async () => {
    await expect(archivePlan({ kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 1 }, 'https://api.github.com', 'main', api({}))).rejects.toThrow(/no commit/);
  });
});

it('MAX_CHANGED_FILES keeps per-file fetching well under GitHub\'s hourly token limit', () => {
  expect(MAX_CHANGED_FILES).toBeLessThanOrEqual(500);
});

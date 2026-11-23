import { isIndexable, readerContext, tarFiles, type Extractor, type FileSymbols, type FindingContext } from '@repospector/core';
import { gitBlobId, KEEP_GRAPHS, type BlobSymbols, type IndexCache, type SavedGraph } from './cache.js';

export interface IndexJob {
  /** `<host>/<repo path>`, e.g. github.com/vercel/ms */
  readonly repo: string;
  readonly sha: string;
  readonly findings: readonly { id: string; file: string; line: number }[];
  /** Gzipped tar at `sha`; absent when only a saved index may be used. */
  readonly archiveUrl?: string | undefined;
  /** For the archive download; sent only for private repositories (the download is redirected). */
  readonly token?: string | undefined;
  /** For GitHub API calls (same origin, no redirects followed): listing files and fetching changed ones. */
  readonly apiToken?: string | undefined;
  /** GitHub API URL of the repository (`…/repos/o/r`): enables fetching only changed files. */
  readonly githubRepoApi?: string | undefined;
  readonly maxDownloadBytes: number;
}

export type IndexSource = 'saved' | 'changed-files' | 'download';

export interface IndexResult {
  readonly source: IndexSource;
  readonly files: number;
  readonly skipped: number;
  /** Files whose symbols came from the saved index instead of being parsed again. */
  readonly reused: number;
  readonly context: Record<string, FindingContext>;
}

export interface IndexDeps {
  readonly fetch: typeof fetch;
  readonly extractor: Extractor;
  readonly cache: IndexCache;
  readonly now: () => number;
  readonly onProgress?: (files: number, downloadedBytes: number) => void;
}

/** More changed files than this and a full download is cheaper than one request per file. */
export const MAX_CHANGED_FILES = 200;
const CONCURRENCY = 8;

export class NoSavedIndex extends Error {}

function limit(maxBytes: number, onBytes: (n: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, ctl) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`the repository download is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, so it was stopped`);
      onBytes(total);
      ctl.enqueue(chunk);
    },
  });
}

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    reader.releaseLock();
  }
}

const authHeaders = (token: string | undefined, accept?: string): Headers => new Headers({ ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) });

/** Symbols for every path, from the cache, as the map readerContext takes. */
async function contextFrom(graph: SavedGraph, cache: IndexCache, findings: IndexJob['findings'], known?: ReadonlyMap<string, BlobSymbols>): Promise<Record<string, FindingContext>> {
  const missing = graph.files.map(([, b]) => b).filter((b) => !known?.has(b));
  const loaded = missing.length ? await cache.getSymbols(missing) : new Map<string, BlobSymbols>();
  const symbols = new Map<string, FileSymbols>();
  for (const [path, blob] of graph.files) {
    const s = known?.get(blob) ?? loaded.get(blob);
    if (s) symbols.set(path, s);
  }
  return readerContext(symbols, findings);
}

/** GitHub only, with a token: list files at `sha` (one request) and fetch just the ones not saved. */
async function changedFiles(job: IndexJob, deps: IndexDeps, known: Map<string, BlobSymbols>): Promise<{ files: [string, string][]; skipped: number; parsed: Map<string, BlobSymbols> } | null> {
  const res = await deps.fetch(`${job.githubRepoApi}/git/trees/${job.sha}?recursive=1`, { headers: authHeaders(job.apiToken, 'application/vnd.github+json'), credentials: 'omit', redirect: 'error' });
  if (!res.ok) return null;
  const tree = (await res.json()) as { truncated?: boolean; tree?: { path: string; type: string; sha: string; size?: number }[] };
  if (tree.truncated || !tree.tree) return null;
  const blobs = tree.tree.filter((e) => e.type === 'blob');
  const wanted = blobs.filter((e) => isIndexable(e.path, e.size ?? 0));
  const missing = [...new Set(wanted.map((e) => e.sha).filter((s) => !known.has(s)))];
  if (missing.length > MAX_CHANGED_FILES) return null;
  const pathOf = new Map(wanted.map((e) => [e.sha, e.path]));
  const parsed = new Map<string, BlobSymbols>();
  const queue = [...missing];
  const decoder = new TextDecoder();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let sha = queue.shift(); sha; sha = queue.shift()) {
        const r = await deps.fetch(`${job.githubRepoApi}/git/blobs/${sha}`, { headers: authHeaders(job.apiToken, 'application/vnd.github.raw'), credentials: 'omit', redirect: 'error' });
        if (!r.ok) throw new Error(`GitHub answered ${r.status} for a changed file`);
        const data = new Uint8Array(await r.arrayBuffer());
        if ((await gitBlobId(data)) !== sha) throw new Error('a changed file did not match its id; try again');
        parsed.set(sha, (await deps.extractor.extractSymbols(pathOf.get(sha) ?? '', decoder.decode(data))) ?? null);
      }
    }),
  );
  return { files: wanted.map((e) => [e.path, e.sha]), skipped: blobs.length - wanted.length, parsed };
}

/** Full download; files whose content is already saved are not parsed again. */
async function download(job: IndexJob, deps: IndexDeps, known: Map<string, BlobSymbols>) {
  if (!job.archiveUrl) throw new NoSavedIndex('no saved index for this commit');
  const res = await deps.fetch(job.archiveUrl, { headers: authHeaders(job.token), credentials: 'omit', redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(res.status === 404 ? 'the host did not find this commit (404); it may have been force-pushed away' : `the host answered ${res.status} for the repository download`);
  let downloaded = 0;
  const stats = { files: 0, skipped: 0 };
  const files: [string, string][] = [];
  const parsed = new Map<string, BlobSymbols>();
  const decoder = new TextDecoder();
  const gunzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
  const stream = res.body.pipeThrough(limit(job.maxDownloadBytes, (n) => (downloaded = n))).pipeThrough(gunzip);
  try {
    for await (const f of tarFiles(chunks(stream), { maxFileBytes: 1024 * 1024, want: isIndexable }, stats)) {
      const blob = await gitBlobId(f.data);
      files.push([f.path, blob]);
      if (!known.has(blob) && !parsed.has(blob)) parsed.set(blob, (await deps.extractor.extractSymbols(f.path, decoder.decode(f.data))) ?? null);
      if (stats.files % 200 === 0) deps.onProgress?.(stats.files, downloaded);
    }
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/larger than/.test(msg) ? msg : `the repository download was interrupted or damaged (${msg || 'decompression failed'}); try again`);
  }
  return { files, skipped: stats.skipped, parsed };
}

/**
 * Reader context for a commit, using the index saved on this machine when there is one: the same
 * commit is not downloaded again; for a new commit only changed files are parsed (and, on GitHub
 * with a token, only changed files are downloaded). The result is saved for next time.
 */
export async function buildIndex(job: IndexJob, deps: IndexDeps): Promise<IndexResult> {
  const key = `${job.repo}@${job.sha}`;
  const saved = await deps.cache.getGraph(key);
  if (saved) return { source: 'saved', files: saved.files.length, skipped: saved.skipped, reused: saved.files.length, context: await contextFrom(saved, deps.cache, job.findings) };

  // Symbols of the newest saved commit of this repo: most files are unchanged between pushes.
  const previous = await deps.cache.latestGraph(job.repo);
  const known = previous ? await deps.cache.getSymbols([...new Set(previous.files.map(([, b]) => b))]) : new Map<string, BlobSymbols>();
  // Without a token GitHub allows 60 API calls an hour, too few for one request per changed file.
  const viaTree = job.githubRepoApi && job.apiToken && previous ? await changedFiles(job, deps, known) : null;
  const got = viaTree ?? (await download(job, deps, known));
  await deps.cache.putSymbols(got.parsed);
  const graph: SavedGraph = { key, repo: job.repo, files: got.files, skipped: got.skipped, at: deps.now() };
  await deps.cache.putGraph(graph);
  await deps.cache.prune(KEEP_GRAPHS);
  const all = new Map([...known, ...got.parsed]);
  return { source: viaTree ? 'changed-files' : 'download', files: got.files.length, skipped: got.skipped, reused: got.files.filter(([, b]) => !got.parsed.has(b)).length, context: await contextFrom(graph, deps.cache, job.findings, all) };
}

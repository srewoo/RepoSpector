import { isIndexable, locateDefinitions, MAX_PARSE_BYTES, readerContext, tarFiles, type Extractor, type FileSymbols, type FindingContext, type LocatedDefinitions } from '@repospector/core';
import { gitBlobId, KEEP_GRAPHS, type BlobSymbols, type IndexCache, type SavedGraph } from './cache.js';

export interface IndexJob {
  /** `<host>/<repo path>`, e.g. github.com/vercel/ms */
  readonly repo: string;
  readonly sha: string;
  readonly findings: readonly { id: string; file: string; line: number }[];
  /** Repository-context pass: names the diff calls, and the diff's added lines per file (definitions there are skipped). */
  readonly locate?: { readonly names: readonly string[]; readonly addedLines: readonly (readonly [string, readonly number[]])[] } | undefined;
  /** Gzipped tar at `sha`; absent when only a saved index may be used. */
  readonly archiveUrl?: string | undefined;
  /** For the archive download; sent only for private repositories (the download is redirected). */
  readonly token?: string | undefined;
  /** For GitHub API calls (same origin, no redirects followed): listing files and fetching changed ones. */
  readonly apiToken?: string | undefined;
  /** GitHub API URL of the repository (`…/repos/o/r`): enables fetching only changed files. */
  readonly githubRepoApi?: string | undefined;
  /**
   * GitLab API URL of the project (`…/api/v4/projects/<id>`). GitLab answers 406 to archive downloads
   * from an extension (Origin chrome-extension:// with Sec-Fetch-Mode cors), so GitLab is indexed
   * through the tree API and per-file blobs instead, which also fetches only files not saved yet.
   */
  readonly gitlabProjectApi?: string | undefined;
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
  /** Only when the job asked to locate names. */
  readonly definitions?: LocatedDefinitions;
}

export interface IndexDeps {
  readonly fetch: typeof fetch;
  readonly extractor: Extractor;
  readonly cache: IndexCache;
  readonly now: () => number;
  readonly onProgress?: (files: number, downloadedBytes: number) => void;
  /** Injected in tests; real waits otherwise. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** More changed files than this and a full download is cheaper than one request per file. */
export const MAX_CHANGED_FILES = 200;
/** GitLab has no usable download for extensions: cap the files fetched one by one for a first index. */
export const MAX_GITLAB_FILES = 3_000;
const MAX_TREE_PAGES = 200;
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

/** Symbols for every path, from the cache, as the map readerContext and locateDefinitions take. */
async function symbolsFrom(graph: SavedGraph, cache: IndexCache, known?: ReadonlyMap<string, BlobSymbols>): Promise<Map<string, FileSymbols>> {
  const missing = graph.files.map(([, b]) => b).filter((b) => !known?.has(b));
  const loaded = missing.length ? await cache.getSymbols(missing) : new Map<string, BlobSymbols>();
  const symbols = new Map<string, FileSymbols>();
  for (const [path, blob] of graph.files) {
    const s = known?.get(blob) ?? loaded.get(blob);
    if (s) symbols.set(path, s);
  }
  return symbols;
}

/** What the job asked for, from the symbols of the whole repository at the commit. */
function answer(job: IndexJob, symbols: ReadonlyMap<string, FileSymbols>): Pick<IndexResult, 'context' | 'definitions'> {
  const added = new Map((job.locate?.addedLines ?? []).map(([f, lines]) => [f, new Set(lines)]));
  return { context: readerContext(symbols, job.findings), ...(job.locate ? { definitions: locateDefinitions(symbols, job.locate.names, added) } : {}) };
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

/** Rate limits (gitlab.com: 500 calls a minute without a token): wait as told, at most 3 times. */
async function fetchRetrying(deps: IndexDeps, url: string, token: string | undefined): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await deps.fetch(url, { headers: authHeaders(token), credentials: 'omit', redirect: 'error' });
    if (r.status !== 429 || attempt >= 3) return r;
    const after = Number(r.headers.get('retry-after'));
    await (deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(Math.min(60_000, Number.isFinite(after) && after > 0 ? after * 1000 : 10_000 * (attempt + 1)));
  }
}

/** Fetches blobs by id (8 at a time), checks each against its id, and parses it. */
async function fetchBlobs(ids: readonly string[], url: (sha: string) => string, token: string | undefined, pathOf: ReadonlyMap<string, string>, deps: IndexDeps, label: string): Promise<Map<string, BlobSymbols>> {
  const parsed = new Map<string, BlobSymbols>();
  const queue = [...ids];
  const decoder = new TextDecoder();
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let sha = queue.shift(); sha; sha = queue.shift()) {
        const r = await fetchRetrying(deps, url(sha), token);
        if (!r.ok) throw new Error(r.status === 429 ? `${label} kept rate limiting the file downloads (429); try again in a few minutes` : `${label} answered ${r.status} for a file`);
        const data = new Uint8Array(await r.arrayBuffer());
        if ((await gitBlobId(data)) !== sha) throw new Error('a file did not match its id; try again');
        parsed.set(sha, data.length > MAX_PARSE_BYTES ? null : ((await deps.extractor.extractSymbols(pathOf.get(sha) ?? '', decoder.decode(data))) ?? null));
        if (++done % 100 === 0) deps.onProgress?.(done, 0);
      }
    }),
  );
  return parsed;
}

/** GitLab: list the files at `sha` with the tree API (paginated, same origin only), fetch the ones not saved. */
async function gitlabFiles(job: IndexJob, deps: IndexDeps, known: Map<string, BlobSymbols>): Promise<{ files: [string, string][]; skipped: number; parsed: Map<string, BlobSymbols> }> {
  const api = job.gitlabProjectApi ?? '';
  const origin = new URL(api).origin;
  const entries: { path: string; type: string; id: string }[] = [];
  let next: string | undefined = `${api}/repository/tree?ref=${encodeURIComponent(job.sha)}&recursive=true&per_page=100`;
  for (let page = 0; next; page++) {
    if (page >= MAX_TREE_PAGES) throw new Error(`the repository has more than ${MAX_TREE_PAGES * 100} files, too many to index through the GitLab API`);
    const res: Response = await deps.fetch(next, { headers: authHeaders(job.apiToken, 'application/json'), credentials: 'omit', redirect: 'error' });
    if (!res.ok) throw new Error(res.status === 404 ? 'GitLab did not find this commit or project (404); a private project needs an access token' : `GitLab answered ${res.status} when listing files`);
    entries.push(...((await res.json()) as typeof entries));
    const link = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    // The token never follows a link to another origin.
    next = link && new URL(link).origin === origin ? link : undefined;
  }
  const blobs = entries.filter((e) => e.type === 'blob');
  // The tree API gives no sizes; oversized files are skipped after download.
  const wanted = blobs.filter((e) => isIndexable(e.path, 0));
  const missing = [...new Set(wanted.map((e) => e.id).filter((id) => !known.has(id)))];
  if (missing.length > MAX_GITLAB_FILES) throw new Error(`${missing.length} source files would have to be fetched one by one, more than the ${MAX_GITLAB_FILES} RepoSpector reads through the GitLab API`);
  const parsed = await fetchBlobs(missing, (id) => `${api}/repository/blobs/${id}/raw`, job.apiToken, new Map(wanted.map((e) => [e.id, e.path])), deps, 'GitLab');
  return { files: wanted.map((e) => [e.path, e.id]), skipped: blobs.length - wanted.length, parsed };
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
  if (saved) return { source: 'saved', files: saved.files.length, skipped: saved.skipped, reused: saved.files.length, ...answer(job, await symbolsFrom(saved, deps.cache)) };

  // Symbols of the newest saved commit of this repo: most files are unchanged between pushes.
  const previous = await deps.cache.latestGraph(job.repo);
  const known = previous ? await deps.cache.getSymbols([...new Set(previous.files.map(([, b]) => b))]) : new Map<string, BlobSymbols>();
  // Without a token GitHub allows 60 API calls an hour, too few for one request per changed file.
  const viaTree = job.gitlabProjectApi ? await gitlabFiles(job, deps, known) : job.githubRepoApi && job.apiToken && previous ? await changedFiles(job, deps, known) : null;
  const got = viaTree ?? (await download(job, deps, known));
  await deps.cache.putSymbols(got.parsed);
  const graph: SavedGraph = { key, repo: job.repo, files: got.files, skipped: got.skipped, at: deps.now() };
  await deps.cache.putGraph(graph);
  await deps.cache.prune(KEEP_GRAPHS);
  const all = new Map([...known, ...got.parsed]);
  return { source: viaTree && previous ? 'changed-files' : 'download', files: got.files.length, skipped: got.skipped, reused: got.files.filter(([, b]) => !got.parsed.has(b)).length, ...answer(job, await symbolsFrom(graph, deps.cache, all)) };
}

import { readerContext } from '@repospector/core';
import { z } from 'zod';
import { GitRepo } from '../git.js';
import { GraphService } from '../graph/service.js';
import { remoteKey, type NativeConfig } from './config.js';

/** Messages the extension may send. Anything else is answered with an error, never acted on. */
const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello') }).strict(),
  z
    .object({
      type: z.literal('context'),
      repo: z.string().max(300).regex(/^[a-z0-9.-]+(:\d{1,5})?\/[^\s@]+$/i),
      sha: z.string().regex(/^[0-9a-f]{40}$/),
      findings: z.array(z.object({ id: z.string().max(64), file: z.string().max(500), line: z.number().int().positive() }).strict()).max(500),
    })
    .strict(),
]);

export type NativeReply =
  | { ok: true; version: string; repos: { path: string; remotes: string[] }[] }
  | { ok: true; files: number; ms: number; context: Record<string, unknown> }
  | { ok: false; reason: 'bad-request' | 'not-cloned' | 'missing-commit' | 'no-graph' | 'error'; message: string };

export interface HandlerDeps {
  readonly config: () => NativeConfig;
  readonly version: string;
  readonly cacheDir?: string | undefined;
  /** How long to wait for a first build of a commit. */
  readonly buildWaitMs?: number | undefined;
}

async function remotesOf(path: string): Promise<{ repo: GitRepo; keys: string[] } | undefined> {
  try {
    const repo = await GitRepo.open(path);
    const out = await repo.git(['remote', '-v']);
    const keys = [...new Set(out.split('\n').map((l) => remoteKey(l.split(/\s+/)[1] ?? '')).filter((k): k is string => Boolean(k)))];
    return { repo, keys };
  } catch {
    return undefined; // moved, deleted or not a repository any more
  }
}

async function hasCommit(repo: GitRepo, sha: string): Promise<boolean> {
  try {
    return (await repo.resolveCommit(sha)) === sha;
  } catch {
    return false;
  }
}

/** One request from the extension. Reads only repositories listed in the config. */
export async function handleNative(message: unknown, deps: HandlerDeps): Promise<NativeReply> {
  const parsed = RequestSchema.safeParse(message);
  if (!parsed.success) return { ok: false, reason: 'bad-request', message: 'unknown or malformed request' };
  const req = parsed.data;
  const listed = deps.config().repos;
  if (req.type === 'hello') {
    const repos = await Promise.all(listed.map(async (path) => ({ path, remotes: (await remotesOf(path))?.keys ?? [] })));
    return { ok: true, version: deps.version, repos };
  }
  const want = req.repo.toLowerCase();
  let match: GitRepo | undefined;
  for (const path of listed) {
    const r = await remotesOf(path);
    if (r?.keys.includes(want)) {
      match = r.repo;
      break;
    }
  }
  if (!match) return { ok: false, reason: 'not-cloned', message: `no listed clone has a remote for ${req.repo}; add one with \`repospector-mcp native add-repo <path>\`` };
  if (!(await hasCommit(match, req.sha))) return { ok: false, reason: 'missing-commit', message: `the clone at ${match.root} does not have commit ${req.sha.slice(0, 12)}; run git fetch there` };
  const started = Date.now();
  const service = await GraphService.open(match, deps.cacheDir);
  if (!service) return { ok: false, reason: 'no-graph', message: 'the local code index needs Node 22.13 or later (node:sqlite)' };
  try {
    const symbols = await service.allSymbolsAt(req.sha, deps.buildWaitMs ?? 120_000);
    if (!symbols) return { ok: false, reason: 'error', message: 'indexing this commit took too long; try again in a minute' };
    return { ok: true, files: symbols.size, ms: Date.now() - started, context: readerContext(symbols, req.findings) };
  } finally {
    service.close();
  }
}

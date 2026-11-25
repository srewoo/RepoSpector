import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CheckoutRequest {
  readonly cacheDir: string;
  /** owner/name on GitHub. */
  readonly repo: string;
  readonly number: number;
  /** Defaults to https://github.com/<repo>.git; tests pass a local path. */
  readonly remoteUrl?: string;
}

export interface Checkout {
  readonly dir: string;
  readonly headSha: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** One queue per store: concurrent checkouts of the same repo would race on init, fetch and worktree add. */
const storeQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (storeQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  storeQueues.set(key, next.catch(() => undefined));
  return next;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/**
 * A detached worktree at the PR head. One object store per repo, filled by shallow fetches of
 * each PR head (depth 1), so a large repo costs one tree of files per PR, not its whole history.
 */
export async function prepareCheckout(req: CheckoutRequest): Promise<Checkout> {
  if (!REPO_RE.test(req.repo) || req.repo.includes('..')) throw new Error(`invalid repo: ${req.repo}`);
  if (!Number.isInteger(req.number) || req.number <= 0) throw new Error(`invalid PR number: ${req.number}`);
  const slug = req.repo.replace('/', '__');
  // Absolute: git -C <store> resolves a relative worktree path against the store, not our cwd.
  const store = join(resolve(req.cacheDir), 'stores', slug);
  return serialized(store, () => checkoutLocked(req, slug, store));
}

async function checkoutLocked(req: CheckoutRequest, slug: string, store: string): Promise<Checkout> {
  const dir = join(resolve(req.cacheDir), 'worktrees', `${slug}__${req.number}`);
  const prRef = `refs/rs/pr-${req.number}`;

  if (!existsSync(store)) {
    mkdirSync(store, { recursive: true });
    await git(store, 'init', '-q', '--bare');
    await git(store, 'remote', 'add', 'origin', req.remoteUrl ?? `https://github.com/${req.repo}.git`);
  }
  let headSha = await git(store, 'rev-parse', '--verify', '--quiet', `${prRef}^{commit}`).catch(() => '');
  if (!headSha) {
    await git(store, 'fetch', '-q', '--depth=1', 'origin', `+refs/pull/${req.number}/head:${prRef}`);
    headSha = await git(store, 'rev-parse', '--verify', `${prRef}^{commit}`);
  }
  if (!existsSync(dir)) {
    mkdirSync(join(resolve(req.cacheDir), 'worktrees'), { recursive: true });
    await git(store, 'worktree', 'add', '-q', '--detach', dir, headSha);
  }
  return { dir, headSha };
}

/** Adds one commit (depth 1) to the repo's object store, e.g. a PR's merge base, so worktrees can diff against it. */
export async function fetchCommit(cacheDir: string, repo: string, sha: string): Promise<void> {
  if (!REPO_RE.test(repo) || repo.includes('..')) throw new Error(`invalid repo: ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid commit: ${sha}`);
  const store = join(resolve(cacheDir), 'stores', repo.replace('/', '__'));
  await serialized(store, async () => {
    try {
      await git(store, 'cat-file', '-e', `${sha}^{commit}`);
    } catch {
      await git(store, 'fetch', '-q', '--depth=1', 'origin', sha);
    }
  });
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCheckout } from '../src/checkout.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** A bare "remote" with main and a PR head published under refs/pull/7/head, like GitHub. */
function makeRemote() {
  const work = mkdtempSync(join(tmpdir(), 'rs-remote-work-'));
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@e');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'base\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(work, 'a.txt'), 'changed\n');
  git(work, 'commit', '-qam', 'pr');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  writeFileSync(join(work, 'b.txt'), 'main moved\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'main moves');
  const remote = mkdtempSync(join(tmpdir(), 'rs-remote-'));
  execFileSync('git', ['clone', '-q', '--bare', work, remote]);
  git(remote, 'update-ref', 'refs/pull/7/head', head);
  return { remote, base, head };
}

describe('prepareCheckout', () => {
  it('checks out the PR head from a shallow fetch', async () => {
    const { remote, head } = makeRemote();
    const cache = mkdtempSync(join(tmpdir(), 'rs-cache-'));
    const co = await prepareCheckout({ cacheDir: cache, repo: 'o/r', number: 7, remoteUrl: `file://${remote}` });
    expect(co.headSha).toBe(head);
    expect(readFileSync(join(co.dir, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(existsSync(join(co.dir, 'b.txt'))).toBe(false);
  });

  it('reuses the clone and worktree on a second call', async () => {
    const { remote } = makeRemote();
    const cache = mkdtempSync(join(tmpdir(), 'rs-cache-'));
    const a = await prepareCheckout({ cacheDir: cache, repo: 'o/r', number: 7, remoteUrl: `file://${remote}` });
    const b = await prepareCheckout({ cacheDir: cache, repo: 'o/r', number: 7, remoteUrl: `file://${remote}` });
    expect(b).toEqual(a);
  });

  it('handles concurrent checkouts of PRs from the same new repo', async () => {
    const { remote, head } = makeRemote();
    execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/8/head', head]);
    const cache = mkdtempSync(join(tmpdir(), 'rs-cache-'));
    const req = (n: number) => prepareCheckout({ cacheDir: cache, repo: 'o/r', number: n, remoteUrl: `file://${remote}` });
    const [a, b] = await Promise.all([req(7), req(8)]);
    expect(a.headSha).toBe(head);
    expect(b.headSha).toBe(head);
  });

  it('puts the worktree under a relative cache dir as seen from the current directory, not inside the store', async () => {
    const { remote, head } = makeRemote();
    const cache = relative(process.cwd(), mkdtempSync(join(tmpdir(), 'rs-cache-')));
    const co = await prepareCheckout({ cacheDir: cache, repo: 'o/r', number: 7, remoteUrl: `file://${remote}` });
    expect(isAbsolute(co.dir)).toBe(true);
    expect(co.dir).toBe(resolve(cache, 'worktrees', 'o__r__7'));
    expect(readFileSync(join(co.dir, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(co.headSha).toBe(head);
  });

  it('rejects repo names that could escape the cache directory', async () => {
    await expect(prepareCheckout({ cacheDir: '/tmp', repo: '../x', number: 1, remoteUrl: '/nope' })).rejects.toThrow(/invalid repo/);
  });
});

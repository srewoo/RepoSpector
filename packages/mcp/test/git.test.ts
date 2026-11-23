import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git.js';
import { RevisionSource } from '../src/source.js';
import { git, makeRepo, write } from './helpers.js';

describe('GitRepo', () => {
  it('resolves refs to full SHAs', async () => {
    const { root, baseSha } = makeRepo();
    const repo = await GitRepo.open(root);
    expect(await repo.resolveCommit('main')).toBe(baseSha);
  });

  it.each(['--output=/tmp/x', '-x', 'a b', 'a;b', '$(id)', ''])('rejects unsafe ref %j', async (ref) => {
    const { root } = makeRepo();
    const repo = await GitRepo.open(root);
    await expect(repo.resolveCommit(ref)).rejects.toThrow(/invalid ref/);
  });

  it('refuses a directory that is not a git repo', async () => {
    await expect(GitRepo.open('/')).rejects.toThrow(/not a git repository/);
  });

  it('diffs the working tree against a base and lists untracked files', async () => {
    const { root, baseSha } = makeRepo();
    const repo = await GitRepo.open(root);
    expect(await repo.diff(baseSha, 'worktree')).toMatch(/i <= items\.length/);
    expect(await repo.untrackedFiles()).toEqual(['src/new.js']);
  });

  it('diffs two commits', async () => {
    const { root, baseSha } = makeRepo();
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'change');
    const repo = await GitRepo.open(root);
    const head = await repo.resolveCommit('HEAD');
    expect(await repo.diff(baseSha, head)).toMatch(/src\/new\.js/);
  });
});

describe('RevisionSource', () => {
  it('counts lines at a commit and in the working tree', async () => {
    const { root, baseSha } = makeRepo();
    const repo = await GitRepo.open(root);
    const atBase = new RevisionSource(repo, baseSha);
    const work = new RevisionSource(repo, 'worktree');
    await atBase.preload(['src/cart.js', 'src/new.js']);
    await work.preload(['src/cart.js', 'src/new.js']);
    expect(atBase.lineCount('src/cart.js')).toBe(7);
    expect(atBase.lineCount('src/new.js')).toBeUndefined();
    expect(work.lineCount('src/new.js')).toBe(2);
    expect(work.snippet('src/cart.js', 3, 3)).toBe('3:   for (let i = 0; i <= items.length; i++) {');
  });

  it('does not follow a symlink out of the repo', async () => {
    const { root } = makeRepo();
    write(root, 'outside-target.txt', 'x\n');
    symlinkSync('/etc/hosts', join(root, 'link.txt'));
    const repo = await GitRepo.open(root);
    const work = new RevisionSource(repo, 'worktree');
    await work.preload(['link.txt', '../etc/passwd']);
    expect(work.lineCount('link.txt')).toBeUndefined();
    expect(work.lineCount('../etc/passwd')).toBeUndefined();
  });
});

describe('GitRepo.grepWords', () => {
  it('finds whole-word matches at a commit and in the worktree, including untracked files', async () => {
    const { root, baseSha } = makeRepo();
    write(root, 'src/use.js', 'import { total } from "./cart";\nconst subtotal = total(items);\n');
    const repo = await GitRepo.open(root);
    const atBase = await repo.grepWords(baseSha, ['total']);
    expect(atBase.map((h) => `${h.file}:${h.line}`)).toEqual(['src/cart.js:1']);
    const inWorktree = await repo.grepWords('worktree', ['total']);
    expect(inWorktree.map((h) => `${h.file}:${h.line}`).sort()).toEqual(['src/cart.js:1', 'src/use.js:1', 'src/use.js:2']);
    expect(inWorktree.find((h) => h.file === 'src/use.js' && h.line === 2)?.text).toBe('const subtotal = total(items);');
  });

  it('returns nothing for no match and rejects names that are not identifiers', async () => {
    const { root } = makeRepo();
    const repo = await GitRepo.open(root);
    expect(await repo.grepWords('worktree', ['noSuchName'])).toEqual([]);
    await expect(repo.grepWords('worktree', ['-e'])).rejects.toThrow(/invalid symbol/);
  });
});

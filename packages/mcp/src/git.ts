import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { WordHit } from '@repospector/core';

const run = promisify(execFile);

const MAX_OUTPUT = 32 * 1024 * 1024;
/** Branch, tag, SHA or rev expression; no leading dash, no whitespace or shell metacharacters. */
const SAFE_REF = /^(?!-)[A-Za-z0-9._\/@{}~^+-]{1,200}$/;

export type Head = string | 'worktree';

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,199}$/;

export class GitError extends Error {}

export interface TreeEntry {
  readonly path: string;
  readonly blob: string;
  readonly size: number;
}

/** Read-only git access to one repository. All calls go through execFile with fixed argument lists. */
export class GitRepo {
  private constructor(readonly root: string) {}

  static async open(dir: string): Promise<GitRepo> {
    let top: string;
    try {
      const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { maxBuffer: MAX_OUTPUT });
      top = stdout.trim();
    } catch {
      throw new GitError(`${dir} is not a git repository`);
    }
    return new GitRepo(await realpath(top));
  }

  async git(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run('git', ['-C', this.root, '-c', 'core.quotePath=false', ...args], {
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      return stdout;
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0];
      throw new GitError(`git ${args[0] ?? ''} failed${stderr ? `: ${stderr}` : ''}`);
    }
  }

  async resolveCommit(ref: string): Promise<string> {
    if (!SAFE_REF.test(ref)) throw new GitError(`invalid ref: ${JSON.stringify(ref.slice(0, 60))}`);
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
    } catch {
      throw new GitError(`unknown ref: ${ref}`);
    }
  }

  /** origin/HEAD, then main, then master; merge-base with the head being reviewed, so only its own work shows. */
  async defaultBase(headSha: string): Promise<string> {
    for (const candidate of ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master']) {
      try {
        const sha = await this.resolveCommit(candidate);
        return (await this.git(['merge-base', sha, headSha])).trim();
      } catch {
        /* try the next candidate */
      }
    }
    throw new GitError('no base found (tried origin/HEAD, main, master); pass base explicitly');
  }

  /** Paths changed from `since` to head (worktree: also uncommitted and untracked), old and new names. */
  async changedPaths(since: string, head: Head): Promise<Set<string>> {
    const range = head === 'worktree' ? [since] : [since, head];
    const out = await this.git(['diff', '--name-status', '--no-color', '-M', ...range, '--']);
    const paths = new Set(out.split('\n').flatMap((l) => l.split('\t').slice(1)).filter(Boolean));
    if (head === 'worktree') for (const p of await this.untrackedFiles()) paths.add(p);
    return paths;
  }

  /** Branch name and commit subjects in base..head: where issue keys usually appear. */
  async refText(baseSha: string, head: Head): Promise<string> {
    const tip = head === 'worktree' ? 'HEAD' : head;
    const [branch, log] = await Promise.all([this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''), this.git(['log', '--format=%s', '-n', '50', `${baseSha}..${tip}`]).catch(() => '')]);
    return `${head === 'worktree' ? branch.trim() : ''}\n${log}`.replace(/[_/]/g, ' ');
  }

  /** Unified diff from base to head; head 'worktree' includes uncommitted tracked changes. */
  async diff(baseSha: string, head: Head): Promise<string> {
    const range = head === 'worktree' ? [baseSha] : [baseSha, head];
    // Fixed prefixes: user config (diff.noprefix, diff.mnemonicPrefix) must not change the paths we parse.
    return this.git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U3', ...range, '--']);
  }

  async untrackedFiles(): Promise<string[]> {
    const out = await this.git(['ls-files', '--others', '--exclude-standard', '-z']);
    return out.split('\0').filter(Boolean).sort();
  }

  /**
   * Whole-word, fixed-string matches of identifiers in text files at a commit, or in the working
   * tree including untracked, non-ignored files. Output is capped at maxHits lines.
   */
  async grepWords(head: Head, names: readonly string[], maxHits = 2000): Promise<WordHit[]> {
    for (const n of names) if (!IDENTIFIER.test(n)) throw new GitError(`invalid symbol: ${JSON.stringify(n.slice(0, 60))}`);
    if (names.length === 0) return [];
    if (head !== 'worktree' && !/^[0-9a-f]{40,64}$/.test(head)) throw new GitError('grep needs a resolved commit');
    const args = ['grep', '-n', '-w', '-F', '-I', '--no-color', '--full-name', ...(head === 'worktree' ? ['--untracked'] : []), ...names.flatMap((n) => ['-e', n])];
    let out = '';
    try {
      out = await this.git([...args, ...(head === 'worktree' ? [] : [head]), '--', '.']);
    } catch (e) {
      // git grep exits 1 when nothing matches; execFile reports that as an error with no stderr.
      if (!(e instanceof GitError) || !/failed$/.test(e.message)) throw e;
    }
    const prefix = head === 'worktree' ? '' : `${head}:`;
    const hits: WordHit[] = [];
    for (const l of out.split('\n')) {
      if (hits.length >= maxHits) break;
      const m = l.slice(prefix.length).match(/^(.+?):(\d+):(.*)$/);
      if (l.startsWith(prefix) && m?.[1] && m[2]) hits.push({ file: m[1], line: Number(m[2]), text: m[3] ?? '' });
    }
    return hits;
  }

  /** Every file (regular or executable blob) at a commit, with its blob id and size in bytes. */
  async lsTree(commit: string): Promise<TreeEntry[]> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError('ls-tree needs a resolved commit');
    const out = await this.git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
    const entries: TreeEntry[] = [];
    for (const rec of out.split('\0')) {
      const m = rec.match(/^(100644|100755) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/s);
      if (m?.[2] && m[3] && m[4]) entries.push({ blob: m[2], size: Number(m[3]), path: m[4] });
    }
    return entries;
  }

  /** Paths that differ from HEAD in the working tree, plus untracked files. */
  async dirtyPaths(): Promise<Set<string>> {
    const changed = await this.git(['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']);
    return new Set([...changed.split('\0').filter(Boolean), ...(await this.untrackedFiles())]);
  }

  /** File content at a commit, or undefined if the path does not exist there. */
  async readAtCommit(sha: string, path: string): Promise<string | undefined> {
    try {
      return await this.git(['cat-file', 'blob', `${sha}:${path}`]);
    } catch {
      return undefined;
    }
  }
}

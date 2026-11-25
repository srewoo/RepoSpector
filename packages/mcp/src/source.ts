import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isSafeRepoPath } from '@repospector/core';
import type { GitRepo, Head } from './git.js';
import { numbered, splitLines, type ReviewSource } from './review-source.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PRELOAD_CONCURRENCY = 16;

/**
 * File lines at the reviewed revision. LineSource is synchronous so the core stays I/O-free;
 * callers preload the paths they are about to check.
 */
export class RevisionSource implements ReviewSource {
  private readonly files = new Map<string, string[] | null>();

  constructor(
    private readonly repo: GitRepo,
    private readonly head: Head,
  ) {}

  async preload(paths: Iterable<string>): Promise<void> {
    const todo = [...new Set(paths)].filter((p) => !this.files.has(p));
    for (let i = 0; i < todo.length; i += PRELOAD_CONCURRENCY) {
      await Promise.all(todo.slice(i, i + PRELOAD_CONCURRENCY).map(async (p) => this.files.set(p, await this.load(p))));
    }
  }

  lineCount(path: string): number | undefined {
    return this.files.get(path)?.length;
  }

  /** Raw lines of a preloaded file; undefined if missing, binary or too large. */
  lines(path: string): readonly string[] | undefined {
    return this.files.get(path) ?? undefined;
  }

  /** Numbered lines, clamped to the file. Empty string if the file is not loaded. */
  snippet(path: string, start: number, end: number): string {
    const lines = this.files.get(path);
    return lines ? numbered(lines, start, end) : '';
  }

  private async load(path: string): Promise<string[] | null> {
    if (!isSafeRepoPath(path)) return null;
    const text = this.head === 'worktree' ? await this.readWorktree(path) : await this.repo.readAtCommit(this.head, path);
    if (text === undefined || text.length > MAX_FILE_BYTES || text.includes('\0')) return null;
    return splitLines(text);
  }

  /** Reads only regular files whose real path stays inside the repo (no symlink escape). */
  private async readWorktree(path: string): Promise<string | undefined> {
    try {
      const real = await realpath(join(this.repo.root, path));
      if (!real.startsWith(this.repo.root + sep)) return undefined;
      const info = await stat(real);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
      return await readFile(real, 'utf8');
    } catch {
      return undefined;
    }
  }
}

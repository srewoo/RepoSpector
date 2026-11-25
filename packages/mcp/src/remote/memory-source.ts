import { numbered, splitLines, type ReviewSource } from '../review-source.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Per review: bounds what an agent can make this process hold. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 3000;

interface Stored {
  readonly lines: string[];
  /** True when the content matched the git blob id the host reported for it. */
  readonly verified: boolean;
  readonly bytes: number;
}

/** File lines at the PR head, as provided by the agent from its GitHub/GitLab MCP tools. */
export class MemorySource implements ReviewSource {
  private readonly files = new Map<string, Stored>();
  private total = 0;

  async preload(_paths: Iterable<string>): Promise<void> {
    // Nothing to load: only files the agent provided exist here.
  }

  /**
   * Stores a file; returns a reason when it cannot. A file is never replaced: findings and verdicts
   * already checked against its lines must keep meaning the same code.
   */
  set(path: string, text: string, verified: boolean, bytes: number): string | null {
    if (this.files.has(path)) return 'already provided (files cannot be replaced within a review)';
    if (this.files.size >= MAX_FILES) return `more than ${MAX_FILES} files in one review`;
    if (this.total + bytes > MAX_TOTAL_BYTES) return `more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB in one review`;
    this.total += bytes;
    this.files.set(path, { lines: splitLines(text), verified, bytes });
    return null;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  isVerified(path: string): boolean {
    return this.files.get(path)?.verified === true;
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  lineCount(path: string): number | undefined {
    return this.files.get(path)?.lines.length;
  }

  lines(path: string): readonly string[] | undefined {
    return this.files.get(path)?.lines;
  }

  snippet(path: string, start: number, end: number): string {
    const f = this.files.get(path);
    return f ? numbered(f.lines, start, end) : '';
  }
}

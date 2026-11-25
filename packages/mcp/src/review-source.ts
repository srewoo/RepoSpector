import type { LineSource } from '@repospector/core';

/**
 * File lines at the reviewed revision, from a local git clone (RevisionSource) or from files the
 * agent fetched with its GitHub/GitLab MCP tools (MemorySource). Synchronous reads, after preload.
 */
export interface ReviewSource extends LineSource {
  preload(paths: Iterable<string>): Promise<void>;
  /** Raw lines of a loaded file; undefined if missing, binary or too large. */
  lines(path: string): readonly string[] | undefined;
  /** Numbered lines, clamped to the file. Empty string if the file is not loaded. */
  snippet(path: string, start: number, end: number): string;
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function numbered(lines: readonly string[], start: number, end: number): string {
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n}: ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}

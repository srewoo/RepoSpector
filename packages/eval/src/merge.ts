import type { BaselineFinding } from './baseline.js';

export const MERGE_LINE_WINDOW = 5;

/**
 * Union of two review passes. A later finding is a duplicate when it is in the same file within
 * MERGE_LINE_WINDOW lines of a finding already kept. Rule fixed before measuring on held-out data.
 */
export function mergeFindings(first: readonly BaselineFinding[], second: readonly BaselineFinding[]): BaselineFinding[] {
  const kept = [...first];
  for (const f of second) {
    if (!kept.some((k) => k.file === f.file && Math.abs(k.line - f.line) <= MERGE_LINE_WINDOW)) kept.push(f);
  }
  return kept;
}

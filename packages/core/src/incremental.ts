import { parseUnifiedDiff, splitDiffByFile } from './diff.js';

/**
 * Re-review after new commits: review only the files that changed since the last reviewed commit,
 * using the pull request's own diff for them (so line numbers stay those of the PR head), and carry
 * the earlier findings in files that did not change.
 */
export function restrictDiff(diffText: string, paths: ReadonlySet<string>): string {
  const parsed = parseUnifiedDiff(diffText);
  return splitDiffByFile(diffText)
    .filter((_, i) => {
      const f = parsed[i];
      return f !== undefined && (paths.has(f.path) || paths.has(f.oldPath));
    })
    .join('');
}

export interface Carryable {
  readonly file: string;
}

/** Earlier findings in files the new commits did not touch; those in touched files are reviewed again. */
export function carryOver<T extends Carryable>(previous: readonly T[], changed: ReadonlySet<string>, stillInDiff: ReadonlySet<string>): T[] {
  return previous.filter((f) => !changed.has(f.file) && stillInDiff.has(f.file));
}

/** Paths of every file in a diff (new path; old path for deletions). */
export function diffPaths(diffText: string): Set<string> {
  return new Set(parseUnifiedDiff(diffText).flatMap((f) => [f.path, f.oldPath]));
}

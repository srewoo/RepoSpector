import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFeedback, parseFeedbackJsonl, toFeedbackJsonl, type FeedbackEntry } from '@repospector/core';
import type { ReviewSource } from './review-source.js';

/** The team's shared feedback, committed in the repo. */
export const SHARED_FEEDBACK = '.RepoSpector/feedback.jsonl';

export class FeedbackError extends Error {}

/** This user's reactions for one repo, kept on this machine only (mode 0600 in the cache dir). */
export class FeedbackLog {
  private constructor(private readonly path: string) {}

  static forRepo(root: string, cacheDir: string): FeedbackLog {
    const name = createHash('sha256').update(root).digest('hex').slice(0, 16);
    return new FeedbackLog(join(cacheDir, `feedback-${name}.jsonl`));
  }

  read(): FeedbackEntry[] {
    return existsSync(this.path) ? parseFeedbackJsonl(readFileSync(this.path, 'utf8')) : [];
  }

  append(entry: FeedbackEntry): void {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, toFeedbackJsonl([entry]), { mode: 0o600 });
  }
}

/** Shared feedback at the reviewed revision; a missing or malformed file yields what parses. */
export async function sharedFeedback(source: ReviewSource): Promise<FeedbackEntry[]> {
  await source.preload([SHARED_FEEDBACK]);
  const lines = source.lines(SHARED_FEEDBACK);
  return lines ? parseFeedbackJsonl(lines.join('\n')) : [];
}

/** Refuses symlinks on the way, so the write cannot land outside the repo. */
function assertNotLinked(root: string): void {
  for (const p of [join(root, '.RepoSpector'), join(root, SHARED_FEEDBACK)]) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new FeedbackError(`${p.slice(root.length + 1)} is a symlink; refusing to write through it`);
  }
}

/**
 * Merges local reactions into the working tree's shared file, for the user to commit. Writes
 * only that one file, and only when something new is added.
 */
export function exportFeedback(root: string, local: readonly FeedbackEntry[]): { path: string; entries: number; added: number } {
  assertNotLinked(root);
  const file = join(root, SHARED_FEEDBACK);
  const existing = existsSync(file) ? parseFeedbackJsonl(readFileSync(file, 'utf8')) : [];
  const merged = mergeFeedback(existing, local);
  const added = merged.length - existing.length;
  if (added > 0) {
    mkdirSync(join(root, '.RepoSpector'), { recursive: true });
    writeFileSync(file, toFeedbackJsonl(merged));
  }
  return { path: SHARED_FEEDBACK, entries: merged.length, added };
}

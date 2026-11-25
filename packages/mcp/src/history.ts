import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The last finalized review per target (a pull/merge request URL, or a local branch), kept on this
 * machine so a later review can cover only what changed since. Mode 0600 in the cache dir; findings
 * are stored as file, line, claim and status only.
 */
const MAX_TARGETS = 50;
const MAX_FINDINGS = 100;

const RememberedFinding = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  severity: z.string(),
  category: z.string(),
  claim: z.string(),
  status: z.string(),
  fingerprint: z.string(),
});
const Entry = z.object({ head: z.string(), at: z.string(), findings: z.array(RememberedFinding).max(MAX_FINDINGS) });
const File = z.record(z.string(), Entry);

export type RememberedReview = z.infer<typeof Entry>;
export type RememberedFindingT = z.infer<typeof RememberedFinding>;

/** One history entry per pull/merge request, whatever tab of it the URL points at. */
export function remoteHistoryKey(url: string): string {
  return `remote:${url.trim().replace(/[?#].*$/, '').replace(/\/(files|commits|checks|diffs|pipelines)\/?$/, '').replace(/\/$/, '')}`;
}

export class ReviewHistory {
  private readonly path: string;

  constructor(cacheDir: string) {
    this.path = join(cacheDir, 'reviews.json');
  }

  static key(target: string): string {
    return createHash('sha256').update(target).digest('hex').slice(0, 24);
  }

  private readAll(): z.infer<typeof File> {
    try {
      if (!existsSync(this.path)) return {};
      const parsed = File.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  get(target: string): RememberedReview | undefined {
    return this.readAll()[ReviewHistory.key(target)];
  }

  remember(target: string, review: RememberedReview): void {
    const all = this.readAll();
    delete all[ReviewHistory.key(target)];
    all[ReviewHistory.key(target)] = { ...review, findings: review.findings.slice(0, MAX_FINDINGS) };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TARGETS))) delete all[k];
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

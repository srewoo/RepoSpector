import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

export const GoldenCommentSchema = z.object({
  comment: z.string().min(1),
  severity: z.string(),
  category: z.string().optional(),
});

const GoldenFileSchema = z.array(
  z.object({ pr_title: z.string(), url: z.string(), comments: z.array(GoldenCommentSchema) }).passthrough(),
);

export interface MartianCase {
  readonly id: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly golden: z.infer<typeof GoldenCommentSchema>[];
}

export function parsePrUrl(url: string): { repo: string; number: number } {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (!m?.[1] || !m[2]) throw new Error(`not a GitHub PR url: ${url}`);
  return { repo: m[1], number: Number(m[2]) };
}

export function parseGoldenFile(raw: unknown): MartianCase[] {
  return GoldenFileSchema.parse(raw).map((pr) => ({
    id: pr.url,
    ...parsePrUrl(pr.url),
    title: pr.pr_title,
    golden: pr.comments.map((c) => ({ comment: c.comment, severity: c.severity, ...(c.category ? { category: c.category } : {}) })),
  }));
}

/** The PR's diff as GitHub shows it (merge-base to head), via the user's gh login. */
export async function fetchPrDiff(repo: string, number: number): Promise<string> {
  const { stdout } = await run('gh', ['api', '-H', 'Accept: application/vnd.github.v3.diff', `repos/${repo}/pulls/${number}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

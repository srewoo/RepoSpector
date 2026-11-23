import { z } from 'zod';
import { parsePrUrl, type MartianCase } from './martian.js';

/**
 * Regression golden set: public PRs later reverted or fixed because they introduced a bug. One
 * known bug per PR, so it measures recall only; precision on it is meaningless (other real bugs in
 * the PR count as false positives). Rules are in eval/data/regressions/SOURCE.md.
 */
export const WINDOW = { from: '2025-07-01T00:00:00Z', to: '2026-11-01T00:00:00Z' } as const;
export const MAX_CHANGED_LINES = 1500;

const PrUrl = z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/);

const RegressionCaseSchema = z
  .object({
    pr_title: z.string().min(1).max(300),
    url: PrUrl,
    language: z.enum(['typescript', 'python', 'go', 'java', 'ruby']),
    merged_at: z.iso.datetime().refine((d) => d >= WINDOW.from && d < WINDOW.to, 'merged outside the window'),
    changed_lines: z.number().int().positive().max(MAX_CHANGED_LINES),
    comments: z.array(z.object({ comment: z.string().min(20).max(1000), severity: z.enum(['Critical', 'High', 'Medium', 'Low']) }).strict()).length(1),
    evidence: z
      .object({
        fix_url: PrUrl,
        fix_kind: z.enum(['revert', 'fix']),
        quote: z.string().min(5).max(1000),
        original_locations: z.array(z.object({ file: z.string().min(1), lines: z.string().regex(/^\d+(-\d+)?$/) }).strict()).min(1),
      })
      .strict(),
  })
  .strict()
  .refine((c) => c.evidence.fix_url !== c.url, 'fix must be a different PR');

export type RegressionCase = MartianCase & { readonly language: string; readonly evidence: z.infer<typeof RegressionCaseSchema>['evidence'] };

export function parseRegressionFile(raw: unknown): RegressionCase[] {
  const cases = z.array(RegressionCaseSchema).parse(raw);
  const seen = new Set<string>();
  return cases.map((c) => {
    if (seen.has(c.url)) throw new Error(`duplicate case ${c.url}`);
    seen.add(c.url);
    return { id: c.url, ...parsePrUrl(c.url), title: c.pr_title, golden: c.comments, language: c.language, evidence: c.evidence };
  });
}

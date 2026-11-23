import { buildPostPlan, type PostableFinding, type ReviewHost } from '@repospector/core';
import type { ReviewFinding, RunRecord } from '../pipeline/engine.js';

export interface PostOutcome {
  /** Inline comments created. */
  readonly posted: number;
  /** Findings with no line in the diff: listed in the review summary instead. */
  readonly inSummary: number;
  /** Selected findings already on the pull request (by marker), so not posted again. */
  readonly alreadyPosted: readonly string[];
  readonly failed: readonly { readonly findingId: string; readonly error: string }[];
  readonly url: string;
}

/** Thrown for problems the user fixes before posting; the message is shown as is. */
export class PostError extends Error {}

export function toPostable(f: ReviewFinding): PostableFinding {
  return { id: f.id, fingerprint: f.fingerprint, file: f.file, startLine: f.line, endLine: f.line, claim: f.claim, status: f.status, suspectedBecause: f.suspectedBecause, tags: [] };
}

/**
 * Posts the selected findings of a finished run as drafts: a GitHub pending review or GitLab draft
 * notes, visible only to the token's owner until they publish. Refuses when the pull request has
 * new commits since the review, because comment lines would no longer match.
 */
export async function postFindings(run: RunRecord, findingIds: readonly string[], host: ReviewHost): Promise<PostOutcome> {
  const byId = new Map((run.findings ?? []).map((f) => [f.id, f]));
  const selected = findingIds.map((id) => byId.get(id));
  if (selected.length === 0) throw new PostError('Select at least one finding to post.');
  if (selected.some((f) => !f)) throw new PostError('Some selected findings are not in this review. Reload the panel and try again.');
  const info = await host.info();
  if (run.headSha && info.headSha !== run.headSha) {
    throw new PostError('The pull request has new commits since this review. Review again before posting, so comments land on the right lines.');
  }
  // GitLab needs hunks() before post(): it learns each file's old path there.
  const hunks = await host.hunks();
  const plan = buildPostPlan((selected as ReviewFinding[]).map(toPostable), hunks, await host.existingMarkers());
  if (plan.inline.length === 0 && plan.inSummary.length === 0) return { posted: 0, inSummary: 0, alreadyPosted: plan.alreadyPosted, failed: [], url: '' };
  const res = await host.post(plan, info);
  return { posted: res.posted, inSummary: plan.inSummary.length, alreadyPosted: plan.alreadyPosted, failed: res.failed, url: res.url };
}

import { describe, expect, it } from 'vitest';
import { GitHubHost, markerFor, type ApiClient, type ReviewTarget } from '@repospector/core';
import type { ReviewFinding, RunRecord } from '../src/pipeline/engine.js';
import { feedbackRow, repoOf } from '../src/review/feedback.js';
import { postFindings, PostError } from '../src/review/post.js';

const target: ReviewTarget = { kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 5 };
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n a\n+b\n+c\n';

const finding = (id: string, line: number, over: Partial<ReviewFinding> = {}): ReviewFinding => ({ id, file: 'src/a.ts', line, claim: `claim ${id} @someone`, status: 'verified', fingerprint: `fp-${id}`, category: 'logic', ...over });
const run = (findings: ReviewFinding[], headSha = 'abc'): RunRecord => ({ id: 'r1', target, provider: 'anthropic', model: 'm', status: 'done', step: 'filter', startedAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, notes: [], headSha, findings });

/** A fake GitHub API: one PR at head `head`, optional existing comment bodies and reviews. */
function fakeApi(head: string, existing: { comments?: string[]; reviews?: { state: string; body: string }[] } = {}): ApiClient & { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  return {
    posts,
    async get(path, opts) {
      if (opts?.accept === 'diff') return DIFF;
      if (path.endsWith('/comments?per_page=100')) return JSON.stringify((existing.comments ?? []).map((body) => ({ body })));
      if (path.endsWith('/reviews?per_page=100')) return JSON.stringify(existing.reviews ?? []);
      return JSON.stringify({ head: { sha: head }, title: 'T' });
    },
    async post(path, body) {
      posts.push({ path, body });
      return JSON.stringify({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-1' });
    },
  };
}

describe('postFindings', () => {
  it('posts only the selected findings as one pending review, inline where the line is in the diff', async () => {
    const api = fakeApi('abc');
    const out = await postFindings(run([finding('f1', 2), finding('f2', 3), finding('f3', 40)]), ['f1', 'f3'], new GitHubHost(target, api));
    expect(out).toMatchObject({ posted: 1, inSummary: 1, failed: [], url: 'https://github.com/o/r/pull/5#pullrequestreview-1' });
    expect(api.posts).toHaveLength(1);
    const body = api.posts[0]?.body as { event?: string; commit_id: string; body: string; comments: { path: string; line: number; side: string; body: string }[] };
    expect(body.event).toBeUndefined(); // no event: the review stays pending (a draft)
    expect(body.commit_id).toBe('abc');
    expect(body.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2, side: 'RIGHT' })]);
    expect(body.comments[0]?.body).toContain(markerFor('fp-f1'));
    expect(body.comments[0]?.body).not.toContain('@someone'); // mentions defused: no notifications
    expect(body.body).toContain('src/a.ts:40');
  });

  it('refuses when the pull request moved since the review, and posts nothing', async () => {
    const api = fakeApi('def');
    await expect(postFindings(run([finding('f1', 2)]), ['f1'], new GitHubHost(target, api))).rejects.toThrow(PostError);
    await expect(postFindings(run([finding('f1', 2)]), ['f1'], new GitHubHost(target, api))).rejects.toThrow(/new commits/);
    expect(api.posts).toEqual([]);
  });

  it('does not post a finding that is already on the pull request', async () => {
    const api = fakeApi('abc', { comments: [`earlier ${markerFor('fp-f1')}`] });
    const out = await postFindings(run([finding('f1', 2)]), ['f1'], new GitHubHost(target, api));
    expect(out).toMatchObject({ posted: 0, alreadyPosted: ['f1'] });
    expect(api.posts).toEqual([]);
  });

  it('stops before posting when the user already has a pending review there', async () => {
    const api = fakeApi('abc', { reviews: [{ state: 'PENDING', body: '' }] });
    await expect(postFindings(run([finding('f1', 2)]), ['f1'], new GitHubHost(target, api))).rejects.toThrow(/pending review/);
    expect(api.posts).toEqual([]);
  });

  it('rejects an empty or unknown selection', async () => {
    const host = new GitHubHost(target, fakeApi('abc'));
    await expect(postFindings(run([finding('f1', 2)]), [], host)).rejects.toThrow(/Select at least one/);
    await expect(postFindings(run([finding('f1', 2)]), ['f9'], host)).rejects.toThrow(/not in this review/);
  });
});

describe('feedbackRow', () => {
  const at = new Date('2026-11-22T00:00:00Z');
  it('maps Useful to accepted and keys the row by fingerprint and repo', () => {
    expect(feedbackRow(finding('f1', 2), 'useful', '', target, at)).toMatchObject({ key: 'fp-f1', choice: 'useful', repo: 'github.com/o/r', entry: { reaction: 'accepted', fingerprint: 'fp-f1', category: 'logic', reason: '' } });
  });
  it('maps Not useful and Not relevant here to rejected, keeping the distinction in the reason', () => {
    expect(feedbackRow(finding('f1', 2), 'not-useful', ' wrong guard ', target, at).entry).toMatchObject({ reaction: 'rejected', reason: 'wrong guard' });
    expect(feedbackRow(finding('f1', 2), 'not-relevant', 'generated file', target, at).entry.reason).toBe('Not relevant here: generated file');
    expect(feedbackRow(finding('f1', 2), 'not-relevant', '', target, at).entry.reason).toBe('Not relevant here');
  });
  it('redacts secrets typed into a reason', () => {
    expect(feedbackRow(finding('f1', 2), 'not-useful', 'see ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', target, at).entry.reason).not.toContain('ghp_');
  });
  it('names GitLab repos by project path', () => {
    expect(repoOf({ kind: 'gitlab', host: 'gitlab.com', project: 'g/p', iid: 1 })).toBe('gitlab.com/g/p');
  });
});

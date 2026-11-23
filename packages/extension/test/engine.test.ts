import { describe, expect, it } from 'vitest';
import { feedbackEntry, type FeedbackEntry, type ReviewTarget } from '@repospector/core';
import { estimateReview, newRun, runReview, type EngineDeps, type RunRecord } from '../src/pipeline/engine.js';
import type { CompletionRequest, CompletionResult, ModelProvider } from '../src/providers/types.js';
import { ProviderError } from '../src/providers/types.js';

const target: ReviewTarget = { kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 5 };
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n a\n+const key = "AKIAABCDEFGHIJKLMNOP";\n';

/** A provider that answers review and verify prompts from scripts, recording what it was sent. */
function scripted(review: string, verify: string, opts: { fail?: ProviderError } = {}): ModelProvider & { prompts: CompletionRequest[] } {
  const prompts: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    model: 'claude-sonnet-5-5',
    prompts,
    async complete(req): Promise<CompletionResult> {
      prompts.push(req);
      if (opts.fail) throw opts.fail;
      const isVerify = req.prompt.includes('<findings>');
      return { text: isVerify ? verify : review, model: 'claude-sonnet-5-5', usage: { inputTokens: 1000, outputTokens: 100 }, stop: 'end', fallbackUsed: false };
    },
  };
}

function deps(provider: ModelProvider, over: Partial<EngineDeps> = {}): EngineDeps & { saved: RunRecord[] } {
  const saved: RunRecord[] = [];
  return {
    host: { info: async () => ({ headSha: 'abc', title: 'Add key loader' }), diff: async () => DIFF },
    provider,
    prices: { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10 },
    feedback: [],
    save: async (r) => void saved.push(structuredClone(r)),
    now: () => 1_000,
    saved,
    ...over,
  };
}

const REVIEW = '[{"file":"src/a.ts","line":2,"claim":"Hard-coded AWS key"},{"file":"src/a.ts","line":1,"claim":"Unused variable a"}]';
const VERIFY = '[{"index":0,"keep":true,"reason":"Line 2 is a literal key."},{"index":1,"keep":false,"reason":"a is exported."}]';

describe('runReview', () => {
  it('fetches, redacts, reviews, verifies (labels, never drops) and records cost', async () => {
    const p = scripted(REVIEW, VERIFY);
    const d = deps(p);
    const run = await runReview(newRun('r1', target, p, 1_000), d);
    expect(run.status).toBe('done');
    expect(run.findings?.map((f) => `${f.status} ${f.file}:${f.line}`)).toEqual(['verified src/a.ts:2', 'suspected src/a.ts:1']);
    expect(run.findings?.[1]?.suspectedBecause).toBe('a is exported.');
    expect(p.prompts[0]?.prompt).toContain('PR title: Add key loader');
    expect(p.prompts[0]?.prompt).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(p.prompts[0]?.system).toBeUndefined();
    expect(run.usage).toEqual({ inputTokens: 2000, outputTokens: 200 });
    expect(run.costUsd).toBeCloseTo((2000 * 2 + 200 * 10) / 1e6, 9);
    expect(run.diff).toBeUndefined();
    expect(d.saved.map((s) => s.step)).toEqual(['fetch', 'review', 'verify', 'filter', 'filter']);
  });

  it('orders findings by verifier confidence, refuted ones last, and keeps every finding', async () => {
    const review = '[{"file":"a.ts","line":1,"claim":"low"},{"file":"a.ts","line":2,"claim":"high"},{"file":"a.ts","line":3,"claim":"refuted"},{"file":"a.ts","line":4,"claim":"no score"},{"file":"a.ts","line":5,"claim":"mid"}]';
    const verify = '[{"index":0,"keep":true,"confidence":20,"reason":"r"},{"index":1,"keep":true,"confidence":90,"reason":"r"},{"index":2,"keep":false,"confidence":95,"reason":"guarded"},{"index":3,"keep":true,"reason":"r"},{"index":4,"keep":true,"confidence":60,"reason":"r"}]';
    const p = scripted(review, verify);
    const run = await runReview(newRun('r9', target, p, 1_000), deps(p));
    expect(run.findings?.map((f) => f.claim)).toEqual(['high', 'mid', 'low', 'no score', 'refuted']);
    expect(run.findings?.map((f) => f.confidence)).toEqual([90, 60, 20, undefined, 95]);
  });

  it('resumes after the review step without calling the model for it again', async () => {
    const p = scripted('SHOULD NOT BE USED', VERIFY);
    const partial: RunRecord = { ...newRun('r1', target, p, 1_000), step: 'verify', headSha: 'abc', title: 'Add key loader', diff: DIFF, review: JSON.parse(REVIEW) };
    const run = await runReview(partial, deps(p));
    expect(p.prompts).toHaveLength(1);
    expect(p.prompts[0]?.prompt).toContain('<findings>');
    expect(run.status).toBe('done');
  });

  it('starts over when the pull request moved on since the saved steps', async () => {
    const p = scripted(REVIEW, VERIFY);
    const stale: RunRecord = { ...newRun('r1', target, p, 1_000), step: 'verify', headSha: 'old', title: 't', diff: 'old diff', review: [{ file: 'x', line: 1, claim: 'old' }] };
    const run = await runReview(stale, deps(p));
    expect(run.headSha).toBe('abc');
    expect(run.findings?.some((f) => f.claim === 'old')).toBe(false);
  });

  it('keeps findings as unchecked when the verifier reply is unreadable', async () => {
    const run = await runReview(newRun('r1', target, scripted(REVIEW, 'not json'), 1_000), deps(scripted(REVIEW, 'not json')));
    expect(run.findings?.every((f) => f.status === 'unchecked')).toBe(true);
    expect(run.notes).toContain('The verifier reply could not be read, so findings are shown unchecked.');
  });

  it('skips the verifier when the review finds nothing', async () => {
    const p = scripted('[]', VERIFY);
    const run = await runReview(newRun('r1', target, p, 1_000), deps(p));
    expect(run.findings).toEqual([]);
    expect(p.prompts).toHaveLength(1);
  });

  it('uses meaning-based matching when given, and falls back to word overlap with a note when it fails', async () => {
    const rejections: FeedbackEntry[] = ['Key literal is fine in fixtures', 'Credentials in tests are expected', 'Test secrets are not real'].map((claim, i) =>
      feedbackEntry({ fingerprint: `x${i}`, category: 'logic', severity: 'medium', claim, file: 'src/a.ts' }, 'rejected', 'noise', new Date(0)),
    );
    const p = scripted(REVIEW, VERIFY);
    const asked: string[][] = [];
    const meaning = async (texts: readonly string[]) => (asked.push([...texts]), (a: string, b: string) => b === 'Hard-coded AWS key' && a.length > 0);
    const run = await runReview(newRun('r1', target, p, 1_000), deps(p, { feedback: rejections, meaning }));
    expect(run.findings?.find((f) => f.claim === 'Hard-coded AWS key')).toMatchObject({ status: 'suspected', suspectedBecause: 'similar to 3 comments your team rejected' });
    expect(asked[0]).toEqual([...rejections.map((e) => e.claim), 'Hard-coded AWS key', 'Unused variable a']);

    const p2 = scripted(REVIEW, VERIFY);
    const failed = await runReview(newRun('r2', target, p2, 1_000), deps(p2, { feedback: rejections, meaning: async () => { throw new Error('the model is not downloaded on this device'); } }));
    expect(failed.status).toBe('done');
    expect(failed.findings?.find((f) => f.claim === 'Hard-coded AWS key')?.status).toBe('verified');
    expect(failed.notes.some((n) => /Meaning-based matching was unavailable \(the model is not downloaded on this device\)/.test(n))).toBe(true);
  });

  it('applies the team feedback filter', async () => {
    const p = scripted(REVIEW, VERIFY);
    const first = await runReview(newRun('r1', target, p, 1_000), deps(p));
    const f0 = first.findings?.[0];
    if (!f0) throw new Error('no finding');
    const rejected: FeedbackEntry = feedbackEntry({ ...f0, severity: 'medium' } as never, 'rejected', 'test fixture', new Date(0));
    const second = await runReview(newRun('r2', target, p, 1_000), deps(scripted(REVIEW, VERIFY), { feedback: [rejected] }));
    expect(second.findings?.find((f) => f.claim === 'Hard-coded AWS key')).toMatchObject({ status: 'suspected', suspectedBecause: expect.stringMatching(/rejected/) });
  });

  it('records a provider failure with its kind and whether to retry', async () => {
    const p = scripted(REVIEW, VERIFY, { fail: new ProviderError('rate_limit', 'Anthropic: rate limited; try again shortly') });
    const run = await runReview(newRun('r1', target, p, 1_000), deps(p));
    expect(run.status).toBe('failed');
    expect(run.error).toEqual({ kind: 'rate_limit', message: 'Anthropic: rate limited; try again shortly', retryable: true });
  });

  it('notes when the diff was too large to review in full', async () => {
    const p = scripted('[]', VERIFY);
    const big = `diff --git a/a b/a\n+${'x'.repeat(310_000)}\n`;
    const run = await runReview(newRun('r1', target, p, 1_000), deps(p, { host: { info: async () => ({ headSha: 'abc', title: 't' }), diff: async () => big } }));
    expect(run.notes.some((n) => n.startsWith('The diff is larger than'))).toBe(true);
  });
});

describe('estimateReview', () => {
  it('gives a cost range from the diff size and dated prices, or null without prices', () => {
    const e = estimateReview(40_000, { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10 });
    expect(e).not.toBeNull();
    expect(e?.lowUsd).toBeGreaterThan(0);
    expect(e?.highUsd).toBeGreaterThan(e?.lowUsd ?? 0);
    expect(estimateReview(40_000, null)).toBeNull();
  });
});

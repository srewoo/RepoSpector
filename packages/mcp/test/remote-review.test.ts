import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitBlobId } from '../src/remote/intake.js';
import { createServer } from '../src/server.js';

const URL = 'https://github.com/acme/shop/pull/42';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);

const CART = `import { applyDiscount } from './price';

export function total(items, pct) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price;
  }
  return applyDiscount(sum, pct);
}
`;
const PRICE = `export function applyDiscount(amount, pct) {
  if (pct > 100) throw new Error('pct over 100');
  return amount * (1 - pct / 100);
}
`;
const PATCH = `@@ -1,8 +1,9 @@
 import { applyDiscount } from './price';

-export function total(items) {
+export function total(items, pct) {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     sum += items[i].price;
   }
-  return sum;
+  return applyDiscount(sum, pct);
 }
`;

const blob = (s: string): string => gitBlobId(Buffer.from(s));

/** A server started outside any git repository: only pull/merge request reviews by URL work. */
async function connect() {
  const notRepo = mkdtempSync(join(tmpdir(), 'rs-norepo-'));
  const server = await createServer({ root: notRepo, cacheDir: mkdtempSync(join(tmpdir(), 'rs-cache-')) });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* error text */
    }
    return { isError: res.isError === true, data, text };
  };
}

async function provided(call: Awaited<ReturnType<typeof connect>>) {
  const start = await call('start_pr_review', { url: URL });
  const reviewId = start.data.reviewId as string;
  const pr = await call('provide_pr', { reviewId, headSha: HEAD, baseSha: BASE, title: 'Discounts', files: [{ path: 'src/cart.js', status: 'modified', patch: PATCH }] });
  return { start, reviewId, pr };
}

describe('pull request review through the agent\'s MCP tools (no local clone)', () => {
  it('says local reviews are off outside a git repo, and points to start_pr_review', async () => {
    const call = await connect();
    const r = await call('plan_review', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/start_pr_review/);
  });

  it('guides the fetch, then refuses to plan until the changed files are provided', async () => {
    const call = await connect();
    const { start, reviewId, pr } = await provided(call);
    expect(start.data.target).toMatchObject({ kind: 'github', owner: 'acme', repo: 'shop', number: 42 });
    expect((start.data.steps as string[]).join(' ')).toMatch(/GitHub MCP/);
    expect(pr.data.needFiles).toEqual(['src/cart.js']);
    expect(pr.data.definitionNames).toContain('applyDiscount');
    const early = await call('plan_review', { reviewId });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/src\/cart\.js/);
  });

  it('reviews end to end: definitions from provided files, findings on provided lines, posting handed back to the agent', async () => {
    const call = await connect();
    const { reviewId } = await provided(call);
    const files = await call('provide_files', {
      reviewId,
      files: [
        { path: 'src/cart.js', content: CART, blobSha: blob(CART) },
        { path: 'src/price.js', content: PRICE.trimEnd(), blobSha: blob(PRICE) },
      ],
    });
    expect(files.data.stored).toEqual([
      { path: 'src/cart.js', lines: 9, verified: true },
      { path: 'src/price.js', lines: 4, verified: true },
    ]);
    expect(files.data.stillNeeded).toEqual([]);

    const plan = await call('plan_review', { reviewId });
    expect(plan.isError).toBe(false);
    expect(plan.data.runId).toBe(reviewId);
    expect(plan.data.contextPackPages).toBe(1);
    expect(plan.data.contextPack).toMatch(/kind="definitions"/);
    expect(plan.data.contextPack).toMatch(/### `applyDiscount` at src\/price\.js:1/);
    expect(plan.data).not.toHaveProperty('remote');

    const ctx = await call('get_context', { runId: reviewId, symbol: 'applyDiscount' });
    expect((ctx.data.definitions as { file: string }[])[0]?.file).toBe('src/price.js');

    const finding = {
      file: 'src/cart.js', startLine: 5, endLine: 6, severity: 'high', category: 'logic',
      reasoning: 'i <= length reads items[length].', claim: 'TypeError: the loop reads one past the end of items.',
      evidence: [{ file: 'src/cart.js', startLine: 5, endLine: 6 }], confidence: 0.9,
    };
    const unprovided = await call('submit_findings', { runId: reviewId, specialist: 'logic', findings: [{ ...finding, evidence: [{ file: 'src/other.js', startLine: 1, endLine: 1 }] }] });
    expect((unprovided.data.rejected as unknown[]).length).toBe(1);
    const specialists = plan.data.specialists as string[];
    for (const s of specialists) await call('submit_findings', { runId: reviewId, specialist: s, findings: s === 'logic' ? [finding] : [] });

    const batch = await call('verify_batch', { runId: reviewId });
    const items = batch.data.findings as { id: string; code: string }[];
    expect(items.find((i) => i.code.includes('i <= items.length'))).toBeDefined();
    const fin = await call('finalize', {
      runId: reviewId,
      batchId: batch.data.batchId,
      verdicts: items.map((i) => ({ findingId: i.id, keep: true, reason: 'No guard.', citation: { file: 'src/cart.js', startLine: 5, endLine: 6 } })),
    });
    expect(fin.isError).toBe(false);

    const wrongPr = await call('post_review', { runId: reviewId, url: 'https://github.com/acme/shop/pull/43' });
    expect(wrongPr.isError).toBe(true);
    const post = await call('post_review', { runId: reviewId, url: URL, includeSuspected: true });
    expect(post.data).toMatchObject({ via: 'agent', commitId: HEAD, handoff: { kind: 'github-pending-review', pullNumber: 42 } });
  });

  it('finishes a review when a specialist was stopped, and reports that area as not reviewed', async () => {
    const call = await connect();
    const { reviewId } = await provided(call);
    await call('provide_files', { reviewId, files: [{ path: 'src/cart.js', content: CART }] });
    const plan = await call('plan_review', { reviewId });
    const specialists = plan.data.specialists as string[];
    expect(specialists.length).toBeGreaterThan(0);
    for (const s of specialists) {
      const skip = await call('skip_specialist', { runId: reviewId, specialist: s, reason: 'stopped by a safety safeguard' });
      expect(skip.isError).toBe(false);
    }
    const batch = await call('verify_batch', { runId: reviewId });
    const fin = await call('finalize', { runId: reviewId, batchId: batch.data.batchId, verdicts: [] });
    expect(fin.isError).toBe(false);
    const coverage = fin.data.coverage as { notCovered: string[]; specialistsRun: string[] };
    expect(coverage.specialistsRun).toEqual([]);
    expect(coverage.notCovered.join(' ')).toMatch(/did not run \(stopped by a safety safeguard\)/);
    expect(fin.data.summary).toMatch(/not reviewed by:/);
  });

  it('refuses a secret file even when the agent provides it', async () => {
    const call = await connect();
    const { reviewId } = await provided(call);
    const r = await call('provide_files', { reviewId, files: [{ path: '.env', content: 'KEY=1\n' }] });
    expect(r.data.refused).toEqual([{ path: '.env', reason: 'possible secrets: never sent to a model' }]);
  });
});

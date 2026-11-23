import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { makeRepo, write } from './helpers.js';

const offByOne = {
  file: 'src/cart.js',
  startLine: 3,
  endLine: 4,
  severity: 'high',
  category: 'logic',
  reasoning: 'Loop runs while i <= length.',
  claim: 'TypeError on every call: loop reads one past the end of items',
  evidence: [{ file: 'src/cart.js', startLine: 3, endLine: 4 }],
  confidence: 0.95,
};

async function connect(root: string, cacheDir: string) {
  const server = await createServer({ root, cacheDir });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown>) => {
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

type Call = Awaited<ReturnType<typeof connect>>;

/** plan → one logic finding → verify (keep) → finalize. */
async function review(call: Call) {
  const plan = await call('plan_review', {});
  const runId = plan.data.runId as string;
  await call('submit_findings', { runId, specialist: 'logic', findings: [offByOne] });
  const batch = await call('verify_batch', { runId });
  const id = (batch.data.findings as { id: string }[])[0]?.id ?? '';
  const fin = await call('finalize', { runId, batchId: batch.data.batchId, verdicts: [{ findingId: id, keep: true, reason: 'No guard.', citation: { file: 'src/cart.js', startLine: 3, endLine: 4 } }] });
  return { runId, findingId: id, findings: fin.data.findings as { id: string; status: string; suspectedBecause?: string }[] };
}

describe('feedback', () => {
  it('a rejected finding comes back as suspected on the next review, with the reason', async () => {
    const { root } = makeRepo();
    const call = await connect(root, mkdtempSync(join(tmpdir(), 'rs-fb-')));
    const first = await review(call);
    expect(first.findings[0]?.status).toBe('verified');
    const rec = await call('record_feedback', { runId: first.runId, findingId: first.findingId, reaction: 'rejected', reason: 'intended: sentinel at the end' });
    expect(rec.isError).toBe(false);
    const second = await review(call);
    expect(second.findings[0]).toMatchObject({ status: 'suspected', suspectedBecause: expect.stringMatching(/rejected this same finding/) });
  });

  it('exports local feedback to .RepoSpector/feedback.jsonl without duplicates, and a fresh machine applies it', async () => {
    const { root } = makeRepo();
    const call = await connect(root, mkdtempSync(join(tmpdir(), 'rs-fb-')));
    const first = await review(call);
    await call('record_feedback', { runId: first.runId, findingId: first.findingId, reaction: 'rejected', reason: 'noise' });
    const exp = await call('export_feedback', {});
    expect(exp.data).toMatchObject({ path: '.RepoSpector/feedback.jsonl', entries: 1, added: 1 });
    const again = await call('export_feedback', {});
    expect(again.data).toMatchObject({ entries: 1, added: 0 });
    const file = join(root, '.RepoSpector', 'feedback.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);

    const teammate = await connect(root, mkdtempSync(join(tmpdir(), 'rs-fb-')));
    const theirs = await review(teammate);
    expect(theirs.findings[0]?.status).toBe('suspected');
  });

  it('ignores a malformed shared file instead of failing the review', async () => {
    const { root } = makeRepo();
    write(root, '.RepoSpector/feedback.jsonl', 'garbage\n{"fingerprint": 3}\n');
    const call = await connect(root, mkdtempSync(join(tmpdir(), 'rs-fb-')));
    expect((await review(call)).findings[0]?.status).toBe('verified');
  });

  it('refuses feedback before finalize and for unknown findings; export with nothing recorded writes no file', async () => {
    const { root } = makeRepo();
    const call = await connect(root, mkdtempSync(join(tmpdir(), 'rs-fb-')));
    const plan = await call('plan_review', {});
    expect((await call('record_feedback', { runId: plan.data.runId, findingId: 'x', reaction: 'rejected' })).text).toMatch(/finalize/);
    const done = await review(call);
    expect((await call('record_feedback', { runId: done.runId, findingId: 'nope', reaction: 'accepted' })).text).toMatch(/unknown finding/);
    expect((await call('export_feedback', {})).data).toMatchObject({ entries: 0, added: 0 });
    expect(existsSync(join(root, '.RepoSpector'))).toBe(false);
  });
});

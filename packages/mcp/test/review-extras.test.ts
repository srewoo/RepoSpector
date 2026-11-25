import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectLocalChecks } from '../src/local-checks.js';
import { createServer } from '../src/server.js';
import { git, makeRepo, write } from './helpers.js';

type Data = Record<string, unknown>;

/** A repo whose change is committed on a branch named after a ticket, with an npm lint script. */
async function connect() {
  const { root } = makeRepo();
  write(root, 'package.json', JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }));
  git(root, 'checkout', '-q', '-b', 'feature/PAY-12-cart-total');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Fix cart total (#7)');
  const cacheDir = mkdtempSync(join(tmpdir(), 'rs-cache-'));
  const server = await createServer({ root, cacheDir, graphWaitMs: 30_000, definitionsWaitMs: 0, cliRunner: async () => Promise.reject(new Error('not logged in')) });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Data = {}): Promise<{ isError: boolean; data: Data; text: string }> => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    let data: Data = {};
    try {
      data = JSON.parse(text) as Data;
    } catch {
      /* plain-text error */
    }
    return { isError: res.isError === true, data, text };
  };
  return { root, call };
}

const finding = {
  file: 'src/cart.js',
  startLine: 3,
  endLine: 3,
  severity: 'high',
  category: 'logic',
  basis: 'The loop condition i <= items.length reads items[items.length], which is undefined.',
  claim: 'TypeError: the loop reads one past the end of items',
  evidence: [{ file: 'src/cart.js', startLine: 3, endLine: 3 }],
  confidence: 0.9,
  fix: { startLine: 3, endLine: 3, replacement: '  for (let i = 0; i < items.length; i++) {' },
};

async function finish(call: Awaited<ReturnType<typeof connect>>['call'], runId: string, specialists: string[], findings: Data[] = [finding]) {
  for (const s of specialists) await call('submit_findings', { runId, specialist: s, findings: s === 'logic' ? findings : [] });
  const batch = await call('verify_batch', { runId });
  const items = batch.data.findings as { id: string; file: string; startLine: number }[];
  return call('finalize', { runId, batchId: batch.data.batchId, verdicts: items.map((f) => ({ findingId: f.id, keep: true, reason: 'confirmed', citation: { file: f.file, startLine: f.startLine, endLine: f.startLine } })) });
}

describe('review extras over MCP', () => {
  it('finds the repo checks and ticket refs, adds issues, summary and check results, and posts them', async () => {
    const { call } = await connect();
    const plan = await call('plan_review', {});
    const runId = plan.data.runId as string;
    expect(plan.data.ticketRefs).toEqual(expect.arrayContaining(['PAY-12', '#7']));
    expect((plan.data.localChecks as { command: string }[]).map((c) => c.command)).toEqual(['npm run lint', 'npm test']);
    expect(plan.data).not.toHaveProperty('reviewedDiff');
    expect(plan.data.previousReview).toBeNull();

    const issues = await call('provide_issues', { runId, issues: [{ ref: 'PAY-12', title: 'Cart total', body: 'Total must include every item. token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] });
    expect(issues.data.specialists).toEqual(['logic', 'requirements']);
    const last = await call('get_context_pack', { runId, page: issues.data.contextPackPages as number });
    expect(last.data.contextPack).toMatch(/Total must include every item/);
    expect(last.data.contextPack).not.toMatch(/ghp_abcdefghijklmnop/);

    await call('submit_summary', { runId, overview: 'Changes the cart loop.', files: [{ path: 'src/cart.js', change: 'loop bound' }] });
    const checks = await call('submit_check_results', { runId, checks: [{ name: 'eslint', command: 'npm run lint', exitCode: 1, output: 'src/cart.js:3:3: error Off by one\nsrc/cart.js:1:1: error not changed\n' }] });
    expect(checks.data.summary).toBe('CI: 1 failing (eslint), 0 passed or skipped.');
    expect(checks.data.diagnostics).toEqual([{ id: 'c1', source: 'eslint', file: 'src/cart.js', line: 3, level: 'error', message: 'Off by one' }]);

    const fin = await finish(call, runId, ['logic', 'requirements']);
    expect(fin.isError).toBe(false);
    expect(fin.data.walkthrough).toMatchObject({ overview: 'Changes the cart loop.' });
    expect((fin.data.findings as Data[])[0]).toMatchObject({ basis: finding.basis, fix: finding.fix });
    expect((fin.data.coverage as { notCovered: string[] }).notCovered.join(' ')).not.toMatch(/requirements|checks/);

    const post = await call('post_review', { runId, url: 'https://github.com/acme/web/pull/1', findingIds: ['f1', 'c1'] });
    expect(post.isError).toBe(false);
    const handoff = post.data.handoff as { body: string; comments: { body: string; line: number }[] };
    expect(handoff.body).toMatch(/^### What this change does/);
    expect(handoff.body).toContain('CI: 1 failing (eslint)');
    expect(handoff.comments.map((c) => c.body).join('\n')).toContain('```suggestion\n  for (let i = 0; i < items.length; i++) {\n```');
    expect(handoff.comments.map((c) => c.body).join('\n')).toContain('eslint: Off by one');
  });

  it('re-reviews only files changed since the last review and carries the rest', async () => {
    const { root, call } = await connect();
    const first = await call('plan_review', {});
    await finish(call, first.data.runId as string, first.data.specialists as string[]);

    write(root, 'src/new.js', 'export const x = 1;\nexport const y = 3;\n');
    git(root, 'commit', '-qam', 'tweak');
    const again = await call('plan_review', { since: 'last' });
    expect(again.isError).toBe(false);
    expect((again.data.files as { path: string }[]).map((f) => f.path)).toEqual(['src/new.js']);
    expect(again.data.previousReview).toMatchObject({ findings: 1 });
    const fin = await finish(call, again.data.runId as string, again.data.specialists as string[], []);
    expect((fin.data.carriedOver as { findings: { file: string }[] }).findings.map((f) => f.file)).toEqual(['src/cart.js']);
    expect((fin.data.coverage as { incremental: { files: string[] } }).incremental.files).toEqual(['src/new.js']);
  });

  it('refuses since "last" with no earlier review', async () => {
    const { call } = await connect();
    expect((await call('plan_review', { since: 'last' })).text).toMatch(/no earlier review/);
  });
});

describe('local check detection', () => {
  it('reads package.json scripts with the right runner and other configs', () => {
    const { root } = makeRepo();
    write(root, 'package.json', JSON.stringify({ scripts: { typecheck: 'tsc -b', test: 'vitest' } }));
    write(root, 'pnpm-lock.yaml', '');
    write(root, 'go.mod', 'module x\n');
    expect(detectLocalChecks(root).map((c) => c.command)).toEqual(['pnpm run typecheck', 'pnpm run test', 'go vet ./...', 'go test ./...']);
  });
});

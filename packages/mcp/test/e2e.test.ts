import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { git, makeRepo, write } from './helpers.js';

interface CallResult {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

async function connect(setup?: (root: string) => void) {
  const { root } = makeRepo();
  setup?.(root);
  const server = await createServer({ root, cacheDir: mkdtempSync(join(tmpdir(), 'rs-cache-')), graphWaitMs: 30_000 });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* error results are plain text */
    }
    return { isError: res.isError === true, data, text };
  };
  return { client, call };
}

const offByOne = {
  file: 'src/cart.js',
  startLine: 3,
  endLine: 4,
  severity: 'high',
  category: 'logic',
  reasoning: 'Loop runs while i <= length, so the last iteration reads items[length], which is undefined.',
  claim: 'TypeError on every call: loop reads one past the end of items',
  evidence: [{ file: 'src/cart.js', startLine: 3, endLine: 4 }],
  confidence: 0.95,
};

describe('MCP server', () => {
  it('lists the tools: none destructive, only post_review reaches outside the machine', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['export_feedback', 'finalize', 'get_agent_prompt', 'get_context', 'get_run_state', 'plan_review', 'post_review', 'record_feedback', 'submit_findings', 'verify_batch'].sort(),
    );
    expect(tools.every((t) => t.annotations?.destructiveHint === false)).toBe(true);
    const post = tools.find((t) => t.name === 'post_review');
    expect(post?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tools.filter((t) => t.name !== 'post_review').every((t) => t.annotations?.openWorldHint === false)).toBe(true);
  });

  it('runs the full flow and enforces the order', async () => {
    const { call } = await connect();

    const plan = await call('plan_review', {});
    expect(plan.isError).toBe(false);
    const runId = plan.data.runId as string;
    const files = plan.data.files as { path: string }[];
    expect(files.map((f) => f.path).sort()).toEqual(['src/cart.js', 'src/new.js']);
    expect(plan.data.tier).toBe('trivial');
    expect(plan.data.specialists).toEqual(['logic']);
    expect(plan.data.contextPack).toMatch(/i <= items\.length/);
    expect(plan.data.contextPack).toMatch(/Never log card numbers/);

    const early = await call('finalize', { runId, batchId: 'x', verdicts: [] });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/wrong-stage/);

    const tooSoon = await call('verify_batch', { runId });
    expect(tooSoon.text).toMatch(/specialists-pending/);

    const prompt = await call('get_agent_prompt', { name: 'logic' });
    expect(prompt.data.prompt).toMatch(/untrusted/);

    const submitted = await call('submit_findings', {
      runId,
      specialist: 'logic',
      findings: [offByOne, { ...offByOne, evidence: [{ file: 'src/cart.js', startLine: 50, endLine: 51 }] }],
    });
    expect((submitted.data.accepted as string[]).length).toBe(1);
    expect((submitted.data.rejected as { reason: string }[])[0]?.reason).toMatch(/outside the file/);

    const batch = await call('verify_batch', { runId });
    expect(batch.data.prompt).toMatch(/disprove/i);
    const items = batch.data.findings as { id: string; code: string; reasoning?: string }[];
    expect(items[0]?.code).toMatch(/i <= items\.length/);
    expect(items[0]?.reasoning).toBeUndefined();

    const fin = await call('finalize', {
      runId,
      batchId: batch.data.batchId,
      verdicts: [
        {
          findingId: items[0]?.id,
          keep: true,
          reason: 'No guard; items[items.length] is undefined.',
          citation: { file: 'src/cart.js', startLine: 3, endLine: 4 },
        },
      ],
    });
    expect(fin.isError).toBe(false);
    const kept = fin.data.findings as { claim: string; confidenceLabel: string }[];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.confidenceLabel).toMatch(/uncalibrated/);
    expect(fin.data.coverage).toMatchObject({ reviewedFiles: ['src/cart.js', 'src/new.js'] });

    const state = await call('get_run_state', { runId });
    expect(state.data.stage).toBe('finalized');
  });

  it('rejects unsafe arguments without running git', async () => {
    const { call } = await connect();
    const bad = await call('plan_review', { base: '--output=/tmp/pwned' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/invalid ref/);

    const run = await call('plan_review', {});
    const traversal = await call('submit_findings', {
      runId: run.data.runId,
      specialist: 'logic',
      findings: [{ ...offByOne, file: '../../etc/passwd' }],
    });
    expect((traversal.data.rejected as unknown[]).length).toBe(1);
  });

  it('reports unknown runs clearly', async () => {
    const { call } = await connect();
    const r = await call('get_run_state', { runId: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown run/);
  });
});

describe('get_context', () => {
  const withCaller = (root: string) => {
    write(root, 'src/checkout.js', 'import { total } from "./cart";\n\nexport function pay(items) {\n  return charge(total(items));\n}\n');
    write(root, '.env', 'total=1\n');
  };

  it('plan_review lists the symbols the change defines', async () => {
    const { call } = await connect(withCaller);
    const plan = await call('plan_review');
    expect(plan.data.changedSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'pay', change: 'defined' })]));
  });

  it('returns the definition with its body and the uses with surrounding lines, at the reviewed revision', async () => {
    const { call } = await connect(withCaller);
    const plan = await call('plan_review');
    const ctx = await call('get_context', { runId: plan.data.runId, symbol: 'total' });
    expect(ctx.isError).toBe(false);
    const defs = ctx.data.definitions as { file: string; line: number; kind: string; code: string }[];
    const uses = ctx.data.usages as { file: string; line: number; kind: string; caller?: string; code: string }[];
    expect(defs.map((d) => `${d.kind} ${d.file}:${d.line}`)).toEqual(['function src/cart.js:1']);
    expect(defs[0]?.code).toContain('i <= items.length');
    expect(defs[0]?.code).toContain('return sum;');
    expect(uses.map((u) => `${u.kind} ${u.file}:${u.line} ${u.caller ?? ''}`.trim())).toEqual(['call src/checkout.js:4 pay', 'reference src/checkout.js:1']);
    expect(uses[0]?.code).toContain('export function pay(items) {');
    expect(JSON.stringify(ctx.data)).not.toContain('.env');
  });

  it('does not call a same-named local variable or comment a definition, and falls back to text search for other languages', async () => {
    const { call } = await connect((root) => {
      write(root, 'src/report.py', '# total is computed elsewhere\ndef summary(rows):\n    total = len(rows)\n    return total\n');
      write(root, 'docs/notes.txt', 'total: see cart\n');
    });
    const plan = await call('plan_review');
    const ctx = await call('get_context', { runId: plan.data.runId, symbol: 'total' });
    const defs = ctx.data.definitions as { file: string }[];
    const uses = ctx.data.usages as { file: string; kind: string }[];
    expect(defs.map((d) => d.file)).toEqual(['src/cart.js']);
    expect(uses.filter((u) => u.file === 'src/report.py').every((u) => u.kind === 'reference')).toBe(true);
    expect(uses.find((u) => u.file === 'docs/notes.txt')?.kind).toBe('text');
  });

  it('refuses a symbol that is not an identifier and an unknown run', async () => {
    const { call } = await connect();
    const plan = await call('plan_review');
    expect((await call('get_context', { runId: plan.data.runId, symbol: '--output=/tmp/x' })).isError).toBe(true);
    expect((await call('get_context', { runId: 'nope', symbol: 'total' })).text).toMatch(/unknown run/);
  });
});

describe('get_context with the stored graph', () => {
  it('answers committed code from the graph, including subclasses, and dirty files on demand', async () => {
    const { call } = await connect((root) => {
      write(root, 'src/shapes.ts', 'export class Shape { area(): number { return 0; } }\nexport class Square extends Shape { area() { return 4; } }\n');
      write(root, 'src/render.ts', 'import { Shape } from "./shapes";\nexport function draw(s: Shape) { return s.area(); }\n');
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'shapes');
      write(root, 'src/circle.ts', 'import { Shape } from "./shapes";\nexport class Circle extends Shape {}\n');
    });
    const plan = await call('plan_review');
    const ctx = await call('get_context', { runId: plan.data.runId, symbol: 'Shape' });
    expect(ctx.data.index).toBe('graph');
    expect((ctx.data.definitions as { file: string; kind: string }[]).map((d) => `${d.kind} ${d.file}`)).toEqual(['class src/shapes.ts']);
    expect((ctx.data.subtypes as { file: string; child: string }[]).map((t) => `${t.child} ${t.file}`).sort()).toEqual(['Circle src/circle.ts', 'Square src/shapes.ts']);
    const area = await call('get_context', { runId: plan.data.runId, symbol: 'area' });
    expect((area.data.usages as { kind: string; caller?: string; file: string }[]).filter((u) => u.kind === 'call').map((u) => `${u.caller} ${u.file}`)).toEqual(['draw src/render.ts']);
  });
});

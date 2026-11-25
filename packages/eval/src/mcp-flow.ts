import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BaselineFinding } from './baseline.js';
import { fetchCommit, prepareCheckout } from './checkout.js';
import type { MartianCase } from './martian.js';

const run = promisify(execFile);
const SERVER = fileURLToPath(new URL('../../mcp/dist/index.js', import.meta.url));
const SKILL = fileURLToPath(new URL('../../mcp/plugin/skills/repospector/SKILL.md', import.meta.url));
const FINALIZE = 'mcp__repospector__finalize';
const PLAN = 'mcp__repospector__plan_review';
const MCP_OUTPUT_TOKENS = 120_000;

export interface FlowFinding {
  readonly file: string;
  readonly startLine: number;
  readonly claim: string;
  readonly status: string;
  readonly severity?: string;
}

export interface FlowResult {
  readonly findings: FlowFinding[] | null;
  readonly definitions?: unknown;
  readonly specialists?: unknown;
  readonly costUsd: number;
  readonly turns: number;
  readonly error?: string;
}

interface StreamBlock {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly tool_use_id?: string;
  readonly content?: unknown;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: unknown }) => (typeof c.text === 'string' ? c.text : '')).join('') : '';

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a `claude -p --output-format stream-json` transcript (subagent messages included) and returns
 * the last successful finalize result, the plan, cost and turns. Finalize results come from the MCP
 * server itself, so the agent cannot alter the findings it reports.
 */
export function parseFlowStream(stream: string): FlowResult {
  const names = new Map<string, string>();
  let final: Record<string, unknown> | undefined;
  let plan: Record<string, unknown> | undefined;
  let costUsd = 0;
  let turns = 0;
  let resultError: string | undefined;
  for (const line of stream.split('\n')) {
    const ev = parseJson(line);
    if (!ev) continue;
    if (ev.type === 'result') {
      costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0;
      turns = typeof ev.num_turns === 'number' ? ev.num_turns : 0;
      if (ev.is_error === true) resultError = String(ev.result ?? ev.subtype ?? 'error').slice(0, 300);
      continue;
    }
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as StreamBlock[]) {
      if (b.type === 'tool_use' && b.id && b.name) names.set(b.id, b.name);
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const name = names.get(b.tool_use_id);
      const body = parseJson(textOf(b.content));
      if (name === FINALIZE && Array.isArray(body?.findings)) final = body;
      if (name === PLAN && body?.runId) plan = body;
    }
  }
  const findings = final ? (final.findings as FlowFinding[]).map((f) => ({ file: f.file, startLine: f.startLine, claim: f.claim, status: f.status, ...(f.severity ? { severity: f.severity } : {}) })) : null;
  return {
    findings,
    definitions: plan?.definitions,
    specialists: plan?.specialists,
    costUsd,
    turns,
    ...(findings ? {} : { error: resultError ?? 'finalize never succeeded' }),
  };
}

function skillSteps(): string {
  const body = readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  // Posting and feedback are user-initiated; the eval stops after finalize.
  return body.split(/\n## 4\. Posting/)[0] ?? body;
}

export function flowPrompt(baseSha: string, headSha: string): string {
  return `${skillSteps()}

Task: review the pull request checked out in this directory. In step 1 call plan_review with base "${baseSha}" and head "${headSha}" (no depth). Do sections 1 and 2 exactly as written, with real subagents. Do not post anything. Instead of section 3, reply with only the word DONE once finalize has succeeded.`;
}

async function mergeBase(c: MartianCase, headSha: string): Promise<string> {
  const { stdout: base } = await run('gh', ['api', `repos/${c.repo}/pulls/${c.number}`, '--jq', '.base.sha']);
  const { stdout } = await run('gh', ['api', `repos/${c.repo}/compare/${base.trim()}...${headSha}`, '--jq', '.merge_base_commit.sha']);
  return stdout.trim();
}

function runClaude(prompt: string, cwd: string, mcpConfig: string, model: string, budgetUsd: number, timeoutMs: number): Promise<string> {
  const args = [
    '-p', '--model', model,
    '--tools', 'Read,Grep,Glob,Agent',
    '--allowedTools', 'Read,Grep,Glob,Agent,mcp__repospector',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--no-session-persistence', '--setting-sources', '',
    '--output-format', 'stream-json', '--verbose',
    '--max-budget-usd', String(budgetUsd),
  ];
  return new Promise((done, fail) => {
    // The plan (diff + definitions) can pass Claude Code's default 25k-token MCP output cap on large PRs.
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAX_MCP_OUTPUT_TOKENS: String(MCP_OUTPUT_TOKENS) } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out) return fail(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      done(out);
    });
    child.stdin.end(prompt);
  });
}

async function pool<T>(items: readonly T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

export interface FlowOptions {
  readonly cacheDir: string;
  readonly model: string;
  readonly concurrency?: number;
  readonly budgetUsd?: number;
}

/**
 * The real MCP flow per PR: a `claude -p` orchestrator with the repospector server (started on a
 * PR-head checkout), following the plugin skill: plan_review (with repository definitions) →
 * specialist subagents → fresh verifier subagent → finalize. Writes <run>/all and <run>/verified
 * predictions for judging; resumable per case (successful cases are not re-run).
 */
export async function runMcpFlow(cases: readonly MartianCase[], runDir: string, o: FlowOptions): Promise<void> {
  mkdirSync(join(runDir, 'all'), { recursive: true });
  mkdirSync(join(runDir, 'verified'), { recursive: true });
  mkdirSync(join(runDir, 'streams'), { recursive: true });
  const recordsPath = join(runDir, 'records.json');
  const records: Record<string, FlowResult> = existsSync(recordsPath) ? (JSON.parse(readFileSync(recordsPath, 'utf8')) as Record<string, FlowResult>) : {};
  const graphCache = resolve(o.cacheDir, 'graph');
  await pool(cases, o.concurrency ?? 3, async (c) => {
    if (records[c.id]?.findings) return;
    const slug = `${c.repo.replace('/', '__')}__${c.number}`;
    try {
      const co = await prepareCheckout({ cacheDir: o.cacheDir, repo: c.repo, number: c.number });
      const base = await mergeBase(c, co.headSha);
      await fetchCommit(o.cacheDir, c.repo, base);
      const cfg = join(resolve(runDir), 'streams', `${slug}.mcp.json`);
      writeFileSync(cfg, JSON.stringify({ mcpServers: { repospector: { command: process.execPath, args: [SERVER, '--repo', resolve(co.dir)], env: { REPOSPECTOR_CACHE_DIR: graphCache } } } }));
      const stream = await runClaude(flowPrompt(base, co.headSha), co.dir, cfg, o.model, o.budgetUsd ?? 8, 45 * 60_000);
      writeFileSync(join(runDir, 'streams', `${slug}.jsonl`), stream);
      records[c.id] = parseFlowStream(stream);
    } catch (e) {
      records[c.id] = { findings: null, costUsd: 0, turns: 0, error: (e as Error).message.slice(0, 300) };
    }
    writeFileSync(recordsPath, `${JSON.stringify(records, null, 2)}\n`);
    const r = records[c.id];
    console.log(`${r?.findings ? 'ok ' : 'ERR'} ${c.id} ${r?.findings?.length ?? r?.error} $${r?.costUsd.toFixed(2)}`);
  });
  const write = (dir: string, keep: (s: string) => boolean): void => {
    const preds: Record<string, { findings: BaselineFinding[] | null; truncated: boolean; error?: string }> = {};
    for (const c of cases) {
      const r = records[c.id];
      preds[c.id] = r?.findings
        ? { findings: r.findings.filter((f) => keep(f.status)).map((f) => ({ file: f.file, line: f.startLine, claim: f.claim })), truncated: false }
        : { findings: null, truncated: false, error: r?.error ?? 'not run' };
    }
    writeFileSync(join(runDir, dir, 'predictions.json'), `${JSON.stringify(preds, null, 2)}\n`);
  };
  write('all', () => true);
  write('verified', (s) => s === 'verified');
  const spend = cases.reduce((n, c) => n + (records[c.id]?.costUsd ?? 0), 0);
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ reviewer: 'MCP flow (plugin skill, specialists + verifier subagents) via claude -p', model: o.model, mcpOutputTokens: MCP_OUTPUT_TOKENS, cases: cases.map((c) => c.id), spendUsd: spend }, null, 2)}\n`);
  console.log(`MCP flow spend (list price): $${spend.toFixed(2)}`);
}

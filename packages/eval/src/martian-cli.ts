#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareCheckout } from './checkout.js';
import { gatherContext } from './context.js';
import { CROSSFILE_PROMPT, reviewCrossFile } from './crossfile.js';
import { DEFINITIONS_ADDENDUM, gatherDefinitions, reviewWithDefinitions } from './definitions.js';
import { BASELINE_PROMPT, CONTEXT_ADDENDUM, candidateText, reviewBaseline, type BaselineFinding } from './baseline.js';
import { JUDGE_PROMPT, judgeReview, totalsOf, type ReviewJudgement } from './judge.js';
import { ClaudeCliClient } from './llm.js';
import { MERGE_LINE_WINDOW, mergeFindings } from './merge.js';
import { VERIFY_PROMPT, VERIFY_REPO_ADDENDUM, verifyFindings } from './verify.js';
import { fetchPrDiff, parseGoldenFile, type MartianCase } from './martian.js';
import { parseRegressionFile } from './regressions.js';
import { runExtensionPipeline } from './extension-run.js';
import { CONCISE_CHECKLIST_PROMPT, CONCISE_PROMPT, RECALL_PROMPT } from '@repospector/core';
import { extensionRepoContext } from './ext-context.js';
import { runMcpFlow } from './mcp-flow.js';
import { resolve } from 'node:path';
import { reviewWithTools, TOOLS_ADDENDUM, writeContextConfig } from './tooluse.js';

const USAGE = `usage:
  martian import   --golden-dir <dir> --out <cases.json> [--regressions]
  martian baseline --cases <cases.json> --run <dir> [--model sonnet] [--limit N | --pilot | --heldout] [--repo-context | --cross-file | --definitions | --context-tool]
  martian verify   --cases <cases.json> --from <dir> --run <dir> [--model sonnet] [--pilot] [--repo-context]
  martian merge    --cases <cases.json> --from <dir> --second <dir> --run <dir> [--pilot | --heldout]
  martian extension --cases <cases.json> --run <dir> [--model sonnet] [--pilot | --heldout] [--limit N] [--repo-context] [--review-prompt baseline|recall|concise|checklist] [--pr-description]
  martian mcp-flow --cases <cases.json> --run <dir> [--model sonnet] [--heldout] [--limit N]
  martian judge    --cases <cases.json> --run <dir> [--judge-model claude-sonnet-4-5-20250929] [--votes 3]`;

const CACHE_DIR = 'eval/.cache';
export const DEFAULT_JUDGE = 'claude-sonnet-4-5-20250929';

interface PredictionEntry {
  readonly findings: BaselineFinding[] | null;
  readonly truncated: boolean;
  readonly error?: string;
  /** --context-tool runs: model turns (above 1 means the tool was used). */
  readonly turns?: number | undefined;
  /** --repo-context runs only: how much context the reviewer got. */
  readonly context?: { symbols: number; hits: number; omitted: number; tooCommon: number; chars: number };
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Two PRs per repo, in file order: a fixed, cheap subset to check the pipeline before a full run. */
export function pilotCases(cases: readonly MartianCase[], perRepo = 2): MartianCase[] {
  const seen = new Map<string, number>();
  return cases.filter((c) => {
    const n = seen.get(c.repo) ?? 0;
    seen.set(c.repo, n + 1);
    return n < perRepo;
  });
}

/** Everything not in the pilot: never used for tuning. */
export function heldoutCases(cases: readonly MartianCase[]): MartianCase[] {
  const pilot = new Set(pilotCases(cases).map((c) => c.id));
  return cases.filter((c) => !pilot.has(c.id));
}

function importCases(dir: string, out: string, regressions: boolean): void {
  // Regression dirs also hold verification.json and the generated cases.json; only golden*.json are cases.
  const files = readdirSync(dir).filter((f) => (regressions ? /^golden.*\.json$/.test(f) : f.endsWith('.json'))).sort();
  const cases = regressions ? parseRegressionFile(files.flatMap((f) => readJson<unknown[]>(join(dir, f)))) : files.flatMap((f) => parseGoldenFile(readJson(join(dir, f))));
  writeJson(out, cases);
  console.log(`${cases.length} cases, ${cases.reduce((n, c) => n + c.golden.length, 0)} golden comments -> ${out}`);
}

type ReviewMode = 'plain' | 'context' | 'crossfile' | 'definitions' | 'tool';

async function runBaseline(cases: MartianCase[], runDir: string, model: string, mode: ReviewMode): Promise<void> {
  const repoContext = mode === 'context' || mode === 'crossfile';
  mkdirSync(runDir, { recursive: true });
  const predPath = join(runDir, 'predictions.json');
  const preds: Record<string, PredictionEntry> = existsSync(predPath) ? readJson(predPath) : {};
  const llm = new ClaudeCliClient(4);
  const manifestPath = join(runDir, 'manifest.json');
  const promptSha = sha(mode === 'tool' ? BASELINE_PROMPT + TOOLS_ADDENDUM : mode === 'definitions' ? BASELINE_PROMPT + DEFINITIONS_ADDENDUM : mode === 'crossfile' ? CROSSFILE_PROMPT : mode === 'context' ? BASELINE_PROMPT + CONTEXT_ADDENDUM : BASELINE_PROMPT);
  if (existsSync(manifestPath)) {
    const prev = readJson<{ promptSha: string; model: string }>(manifestPath);
    if (prev.promptSha !== promptSha || prev.model !== model) throw new Error(`${runDir} was made with a different prompt or model; use a new --run dir`);
  }
  writeJson(manifestPath, {
    reviewer: { plain: 'baseline-single-pass', context: 'baseline+grep-context', crossfile: 'cross-file-pass', definitions: 'baseline+callee-definitions', tool: 'baseline+get_context-tool' }[mode],
    model,
    promptSha,
    cases: cases.map((c) => c.id),
    startedAt: new Date().toISOString(),
  });
  await Promise.all(
    cases.map(async (c) => {
      if (preds[c.id]?.findings) return;
      try {
        const diff = await fetchPrDiff(c.repo, c.number);
        let context: string | undefined;
        let stats: PredictionEntry['context'];
        if (repoContext) {
          const { dir } = await prepareCheckout({ cacheDir: CACHE_DIR, repo: c.repo, number: c.number });
          const g = await gatherContext(diff, dir);
          context = g.pack.text;
          stats = { symbols: g.symbols.length, hits: g.pack.hits.length, omitted: g.pack.omitted, tooCommon: g.tooCommon.length, chars: g.pack.text.length };
        }
        if (mode === 'tool') {
          const co = await prepareCheckout({ cacheDir: CACHE_DIR, repo: c.repo, number: c.number });
          mkdirSync(join(runDir, 'mcp'), { recursive: true });
          const cfg = join(runDir, 'mcp', `${sha(c.id)}.json`);
          writeContextConfig(cfg, resolve(co.dir), co.headSha, resolve(CACHE_DIR, 'graph'));
          const r = await reviewWithTools(c.title, diff, llm, model, cfg);
          preds[c.id] = r.findings ? { findings: r.findings, truncated: r.truncated, turns: r.turns } : { findings: null, truncated: r.truncated, error: `unparseable reply: ${r.raw.slice(0, 200)}` };
          writeJson(predPath, preds);
          console.log(`${preds[c.id]?.findings ? 'ok ' : 'ERR'} ${c.id} ${preds[c.id]?.findings?.length ?? preds[c.id]?.error} turns ${r.turns}`);
          return;
        }
        if (mode === 'definitions') {
          const { dir } = await prepareCheckout({ cacheDir: CACHE_DIR, repo: c.repo, number: c.number });
          const d = await gatherDefinitions(diff, dir);
          context = d.text;
          stats = { symbols: d.names.length, hits: d.found.length, omitted: 0, tooCommon: d.ambiguous.length, chars: d.text.length };
        }
        // No definitions found: the plain baseline prompt, so this pass equals the control pass on that PR.
        const r = mode === 'definitions'
          ? context ? await reviewWithDefinitions(c.title, diff, context, llm, model) : await reviewBaseline(c.title, diff, llm, model)
          : mode === 'crossfile'
          ? { ...(await reviewCrossFile(c.title, diff, context ?? '', llm, model)), truncated: diff.length > 300_000 }
          : await reviewBaseline(c.title, diff, llm, model, context);
        const base = { truncated: r.truncated, ...(stats ? { context: stats } : {}) };
        preds[c.id] = r.findings ? { findings: r.findings, ...base } : { findings: null, ...base, error: `unparseable reply: ${r.raw.slice(0, 200)}` };
      } catch (e) {
        preds[c.id] = { findings: null, truncated: false, error: (e as Error).message.slice(0, 300) };
      }
      writeJson(predPath, preds);
      console.log(`${preds[c.id]?.findings ? 'ok ' : 'ERR'} ${c.id} ${preds[c.id]?.findings?.length ?? preds[c.id]?.error}`);
    }),
  );
  console.log(`model spend (list price): $${llm.totalCostUsd.toFixed(2)} over ${llm.calls} calls`);
}

async function runVerify(cases: MartianCase[], fromDir: string, runDir: string, model: string, repoContext: boolean): Promise<void> {
  mkdirSync(runDir, { recursive: true });
  const source = readJson<Record<string, PredictionEntry>>(join(fromDir, 'predictions.json'));
  const llm = new ClaudeCliClient(4);
  const predPath = join(runDir, 'predictions.json');
  const manifestPath = join(runDir, 'manifest.json');
  const promptSha = sha(repoContext ? VERIFY_PROMPT + VERIFY_REPO_ADDENDUM : VERIFY_PROMPT);
  const manifest = { reviewer: repoContext ? 'baseline+verify-repo' : 'baseline+verify', from: fromDir, model, promptSha, cases: cases.map((c) => c.id) };
  // Resume: keep successful entries, redo only errored or missing ones. Never mix prompts or models in one run.
  if (existsSync(manifestPath)) {
    const prev = readJson<typeof manifest>(manifestPath);
    if (prev.promptSha !== promptSha || prev.model !== model || prev.from !== fromDir) {
      throw new Error(`${runDir} was made with a different prompt, model or source; use a new --run dir`);
    }
  }
  const preds: Record<string, PredictionEntry & { dropped?: unknown; unverified?: number; turns?: number | undefined }> = existsSync(predPath) ? readJson(predPath) : {};
  writeJson(manifestPath, manifest);
  await Promise.all(
    cases.map(async (c) => {
      if (preds[c.id] && !preds[c.id]?.error) return;
      const src = source[c.id];
      if (!src?.findings) return void (preds[c.id] = { findings: null, truncated: false, error: 'no source findings' });
      try {
        const diff = await fetchPrDiff(c.repo, c.number);
        const repoDir = repoContext ? (await prepareCheckout({ cacheDir: CACHE_DIR, repo: c.repo, number: c.number })).dir : undefined;
        const v = await verifyFindings(c.title, diff, src.findings, llm, model, repoDir);
        preds[c.id] = { findings: v.kept, truncated: src.truncated, dropped: v.dropped, unverified: v.unverified, turns: v.turns, ...(v.parseFailed ? { error: 'verifier reply unparseable; kept all' } : {}) };
        console.log(`${c.id} kept ${v.kept.length}/${src.findings.length} turns ${v.turns ?? '?'}${v.parseFailed ? ' (PARSE FAILED)' : ''}`);
      } catch (e) {
        preds[c.id] = { findings: src.findings, truncated: src.truncated, error: `verify failed, kept all: ${(e as Error).message.slice(0, 200)}` };
      }
    }),
  );
  writeJson(predPath, preds);
  console.log(`verify spend (list price): $${llm.totalCostUsd.toFixed(2)} over ${llm.calls} calls`);
}

function runMerge(cases: MartianCase[], firstDir: string, secondDir: string, runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  const a = readJson<Record<string, PredictionEntry>>(join(firstDir, 'predictions.json'));
  const b = readJson<Record<string, PredictionEntry>>(join(secondDir, 'predictions.json'));
  const out: Record<string, PredictionEntry> = {};
  for (const c of cases) {
    const fa = a[c.id]?.findings;
    const fb = b[c.id]?.findings;
    if (!fa && !fb) out[c.id] = { findings: null, truncated: false, error: 'both passes failed' };
    else out[c.id] = { findings: mergeFindings(fa ?? [], fb ?? []), truncated: Boolean(a[c.id]?.truncated || b[c.id]?.truncated) };
  }
  writeJson(join(runDir, 'predictions.json'), out);
  writeJson(join(runDir, 'manifest.json'), { reviewer: 'union of two passes', first: firstDir, second: secondDir, rule: `same file within ${MERGE_LINE_WINDOW} lines` });
  const n = (r: Record<string, PredictionEntry>) => cases.reduce((s, c) => s + (r[c.id]?.findings?.length ?? 0), 0);
  console.log(`first ${n(a)} + second ${n(b)} -> merged ${n(out)} findings`);
}

async function judgeRun(cases: MartianCase[], runDir: string, judgeModel: string, votes = 1): Promise<void> {
  const preds = readJson<Record<string, PredictionEntry>>(join(runDir, 'predictions.json'));
  const cachePath = join(runDir, '..', `judge-cache-${judgeModel}.json`);
  const cache = new Map<string, string>(existsSync(cachePath) ? Object.entries(readJson<Record<string, string>>(cachePath)) : []);
  const llm = new ClaudeCliClient(4);
  const scored = cases.filter((c) => c.id in preds);
  const failed = scored.filter((c) => !preds[c.id]?.findings).map((c) => c.id);

  const perCase: Record<string, ReviewJudgement> = {};
  await Promise.all(
    scored.map(async (c) => {
      const candidates = (preds[c.id]?.findings ?? []).map(candidateText);
      perCase[c.id] = await judgeReview(c.golden.map((g) => g.comment), candidates, llm, judgeModel, cache, votes);
      writeJson(cachePath, Object.fromEntries(cache));
    }),
  );
  const rows = Object.values(perCase);
  const totals = totalsOf(rows);
  const judgeErrors = rows.reduce((n, r) => n + r.errors, 0);
  const report = { judgeModel, judgePromptSha: sha(JUDGE_PROMPT), votes, cases: scored.length, reviewerFailures: failed, judgeErrors, totals, perCase };
  writeJson(join(runDir, votes > 1 ? `report-${judgeModel}-votes${votes}.json` : `report-${judgeModel}.json`), report);
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  console.log(`cases ${scored.length}  TP/FP/FN ${totals.tp}/${totals.fp}/${totals.fn}`);
  console.log(`precision ${pct(totals.precision)}  recall ${pct(totals.recall)}  F1 ${pct(totals.f1)}  (judge ${judgeModel})`);
  if (failed.length) console.log(`reviewer failed on ${failed.length} case(s), scored as zero findings: ${failed.join(', ')}`);
  if (judgeErrors) console.log(`judge errors: ${judgeErrors} pair(s) unparsed; rerun to retry (cached pairs are free)`);
  console.log(`judge spend (list price): $${llm.totalCostUsd.toFixed(2)} over ${llm.calls} calls`);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'golden-dir': { type: 'string' },
      out: { type: 'string' },
      cases: { type: 'string' },
      run: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: DEFAULT_JUDGE },
      votes: { type: 'string', default: '1' },
      limit: { type: 'string' },
      pilot: { type: 'boolean', default: false },
      heldout: { type: 'boolean', default: false },
      from: { type: 'string' },
      second: { type: 'string' },
      'repo-context': { type: 'boolean', default: false },
      'pr-description': { type: 'boolean', default: false },
      'review-prompt': { type: 'string' },
      'cross-file': { type: 'boolean', default: false },
      definitions: { type: 'boolean', default: false },
      regressions: { type: 'boolean', default: false },
      'context-tool': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (cmd === 'import' && values['golden-dir'] && values.out) {
    importCases(values['golden-dir'], values.out, values.regressions);
    return 0;
  }
  if (cmd === 'merge' && values.cases && values.from && values.second && values.run) {
    let cases = readJson<MartianCase[]>(values.cases);
    if (values.pilot) cases = pilotCases(cases);
    if (values.heldout) cases = heldoutCases(cases);
    runMerge(cases, values.from, values.second, values.run);
    return 0;
  }
  if (cmd === 'extension' && values.cases && values.run) {
    let cases = readJson<MartianCase[]>(values.cases);
    if (values.pilot && values.heldout) throw new Error('--pilot and --heldout are exclusive');
    if (values.pilot) cases = pilotCases(cases);
    if (values.heldout) cases = heldoutCases(cases);
    if (values.limit) cases = cases.slice(0, Number(values.limit));
    const promptName = values['review-prompt'] ?? 'baseline';
    const prompts: Record<string, string> = { baseline: BASELINE_PROMPT, recall: RECALL_PROMPT, concise: CONCISE_PROMPT, checklist: CONCISE_CHECKLIST_PROMPT };
    const promptText = prompts[promptName];
    if (!promptText) throw new Error(`--review-prompt must be one of ${Object.keys(prompts).join(', ')}`);
    const llm = new ClaudeCliClient(4);
    await runExtensionPipeline(cases, values.run, values.model === 'sonnet' ? 'claude-sonnet-5-5' : values.model, llm, values['repo-context'] ? (c) => extensionRepoContext(c, CACHE_DIR) : undefined, { name: promptName, text: promptText }, values['pr-description']);
    console.log(`model spend (list price): $${llm.totalCostUsd.toFixed(2)} over ${llm.calls} calls`);
    return 0;
  }
  if (cmd === 'mcp-flow' && values.cases && values.run) {
    let cases = readJson<MartianCase[]>(values.cases);
    if (values.heldout) cases = heldoutCases(cases);
    if (values.limit) cases = cases.slice(0, Number(values.limit));
    await runMcpFlow(cases, values.run, { cacheDir: CACHE_DIR, model: values.model === 'sonnet' ? 'claude-sonnet-5-5' : values.model });
    return 0;
  }
  if ((cmd === 'baseline' || cmd === 'judge' || (cmd === 'verify' && values.from)) && values.cases && values.run) {
    let cases = readJson<MartianCase[]>(values.cases);
    if (values.pilot && values.heldout) throw new Error('--pilot and --heldout are exclusive');
    if (values.pilot) cases = pilotCases(cases);
    if (values.heldout) cases = heldoutCases(cases);
    if (values.limit) cases = cases.slice(0, Number(values.limit));
    if (cmd === 'baseline') {
      const modes = (['repo-context', 'cross-file', 'definitions', 'context-tool'] as const).filter((m) => values[m]);
      if (modes.length > 1) throw new Error(`--${modes.join(' and --')} are exclusive`);
      const mode: ReviewMode = values['cross-file'] ? 'crossfile' : values['repo-context'] ? 'context' : values.definitions ? 'definitions' : values['context-tool'] ? 'tool' : 'plain';
      await runBaseline(cases, values.run, values.model, mode);
    }
    else if (cmd === 'verify') await runVerify(cases, values.from ?? '', values.run, values.model, values['repo-context']);
    else await judgeRun(cases, values.run, values['judge-model'], Math.max(1, Math.min(5, Number(values.votes) || 1)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main(process.argv.slice(2));
}

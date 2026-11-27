#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildVerifyPrompt, foldSameCause, parseVerdicts, redactSecrets, VERIFY_PROMPT, VERIFY_PROMPT_FOLD, VERIFY_PROMPT_V2, type Verdict } from '@repospector/core';
import { byConfidence } from '@repospector/extension/engine';
import { candidateText, type BaselineFinding } from './baseline.js';
import type { ReviewJudgement } from './judge.js';
import { extensionRepoContext } from './ext-context.js';
import { ClaudeCliClient } from './llm.js';
import { fetchPrDiff, type MartianCase } from './martian.js';
import { auc, topN, type RankedCase } from './ranking.js';

const USAGE = `usage:
  rank rerank --cases <cases.json> --from <run dir> --run <out dir> [--model claude-sonnet-5-5] [--prompt v1|v2|fold] [--context]
  rank topn   --cases <cases.json> --run <out dir> [--judge-model claude-sonnet-4-5-20250929]
Then judge <out dir> with martian-cli (same candidate texts, so the judge cache answers it).`;

const run = promisify(execFile);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

type Predictions = Record<string, { findings: BaselineFinding[] | null; truncated?: boolean; error?: string }>;
interface Rank {
  readonly verdicts: Verdict[] | null;
}

function sourcePredictions(from: string): Predictions {
  const all = join(from, 'all', 'predictions.json');
  return readJson<Predictions>(existsSync(all) ? all : join(from, 'predictions.json'));
}

const CACHE_DIR = 'eval/.cache';

async function prInfo(c: MartianCase): Promise<{ title: string; headSha: string }> {
  const { stdout } = await run('gh', ['api', `repos/${c.repo}/pulls/${c.number}`, '--jq', '[.title, .head.sha] | @json'], { maxBuffer: 1024 * 1024 });
  const [title = '', headSha = ''] = JSON.parse(stdout) as string[];
  return { title, headSha };
}

export interface RerankOptions {
  readonly prompt: 'v1' | 'v2' | 'fold';
  /** Give the verifier the extension's repository context (definitions at the PR head). */
  readonly context: boolean;
}

/** The extension's repository context for one PR, or undefined (logged) when it cannot be built. */
async function contextFor(c: MartianCase, diff: string, headSha: string): Promise<string | undefined> {
  try {
    return (await extensionRepoContext(c, CACHE_DIR)({ diff, headSha })).text || undefined;
  } catch (e) {
    console.log(`no context for ${c.id}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Re-runs the (confidence-scoring) verifier over an existing run's findings, in the engine's request shape. */
async function rerank(cases: readonly MartianCase[], from: string, out: string, model: string, opts: RerankOptions): Promise<void> {
  const promptText = { v1: VERIFY_PROMPT, v2: VERIFY_PROMPT_V2, fold: VERIFY_PROMPT_FOLD }[opts.prompt];
  mkdirSync(out, { recursive: true });
  const src = sourcePredictions(from);
  const ranksPath = join(out, 'ranks.json');
  const ranks: Record<string, Rank> = existsSync(ranksPath) ? readJson(ranksPath) : {};
  const llm = new ClaudeCliClient(4);
  const todo = cases.filter((c) => (src[c.id]?.findings?.length ?? 0) > 0 && !ranks[c.id]?.verdicts);
  await Promise.all(
    todo.map(async (c) => {
      const findings = src[c.id]?.findings ?? [];
      const info = await prInfo(c);
      const diff = redactSecrets(await fetchPrDiff(c.repo, c.number));
      const context = opts.context ? await contextFor(c, diff, info.headSha) : undefined;
      const prompt = buildVerifyPrompt(info.title, diff, findings, { prompt: promptText, context });
      let verdicts: Verdict[] | null = null;
      for (let attempt = 0; attempt < 2 && !verdicts; attempt++) verdicts = parseVerdicts((await llm.complete(prompt, { model, system: '', effort: 'medium' })).text);
      ranks[c.id] = { verdicts };
      writeJson(ranksPath, ranks);
      console.log(`${verdicts ? 'ok ' : 'ERR'} ${c.id} ${findings.length} findings`);
    }),
  );
  const preds: Predictions = {};
  const reviewOrder: Record<string, string[]> = {};
  let folded = 0;
  for (const c of cases) {
    const s = src[c.id];
    if (!s) continue;
    const verdicts = ranks[c.id]?.verdicts ?? [];
    const byIndex = new Map(verdicts.map((v) => [v.index, v]));
    const scored = (s.findings ?? []).map((f, i) => ({ f, file: f.file, line: f.line, keep: byIndex.get(i)?.keep ?? true, confidence: byIndex.get(i)?.confidence }));
    // Same as the engine: same-root-cause findings fold into one head before ranking (v2 verdicts only carry sameAs).
    const heads = foldSameCause(scored, new Map(verdicts.flatMap((v) => (v.sameAs === undefined ? [] : [[v.index, v.sameAs] as [number, number]]))));
    folded += scored.length - heads.length;
    const ranked = byConfidence(heads);
    // Same order as the engine: by confidence, then refuted ones below the rest.
    const ordered = [...ranked.filter((r) => r.keep), ...ranked.filter((r) => !r.keep)];
    preds[c.id] = s.findings ? { findings: ordered.map((r) => r.f), truncated: Boolean(s.truncated) } : { findings: null, error: s.error ?? 'not run' };
    reviewOrder[c.id] = (s.findings ?? []).map(candidateText);
  }
  writeJson(join(out, 'predictions.json'), preds);
  writeJson(join(out, 'review-order.json'), reviewOrder);
  writeJson(join(out, 'manifest.json'), { reviewer: `rerank of ${from}`, verifier: model, effort: 'medium', system: 'none', verifyPromptSha: sha(promptText), context: opts.context, folded, order: 'same-cause folded, confidence desc, refuted last' });
  console.log(`folded ${folded} same-cause finding(s)`);
  console.log(`verifier spend (list price): $${llm.totalCostUsd.toFixed(2)} over ${llm.calls} calls`);
}

function topnReport(cases: readonly MartianCase[], out: string, judgeModel: string): void {
  const report = readJson<{ perCase: Record<string, ReviewJudgement> }>(join(out, `report-${judgeModel}.json`));
  const preds = readJson<Predictions>(join(out, 'predictions.json'));
  const reviewOrder = readJson<Record<string, string[]>>(join(out, 'review-order.json'));
  const build = (orderOf: (c: MartianCase) => string[]): RankedCase[] =>
    cases.filter((c) => report.perCase[c.id]).map((c) => {
      const j = report.perCase[c.id];
      if (!j?.matches) throw new Error(`report for ${c.id} has no match pairs; re-run judge (cached pairs are free)`);
      return { order: orderOf(c), golden: c.golden.map((g) => g.comment), matches: j.matches };
    });
  const byConf = build((c) => (preds[c.id]?.findings ?? []).map(candidateText));
  const byReview = build((c) => reviewOrder[c.id] ?? []);
  const pct = (v: number): string => `${(v * 100).toFixed(1)}`.padStart(5);
  const ranksPath = join(out, 'ranks.json');
  if (existsSync(ranksPath)) {
    const ranks = readJson<Record<string, Rank>>(ranksPath);
    const src = readJson<{ reviewer: string }>(join(out, 'manifest.json')).reviewer.replace(/^rerank of /, '');
    const all = sourcePredictions(src);
    const scored = cases.flatMap((c) => {
      const real = new Set((report.perCase[c.id]?.matches ?? []).map((m) => m.candidate));
      const conf = new Map((ranks[c.id]?.verdicts ?? []).map((v) => [v.index, v.confidence ?? 0]));
      const shown = new Set((preds[c.id]?.findings ?? []).map(candidateText));
      return (all[c.id]?.findings ?? []).flatMap((f, i) => (shown.has(candidateText(f)) ? [{ score: conf.get(i) ?? 0, real: real.has(candidateText(f)) }] : []));
    });
    console.log(`AUC of verifier confidence (real vs false, shown findings): ${auc(scored).toFixed(3)} over ${scored.length}`);
  }
  console.log('top N per PR | shown | P confidence | P review order | P random | recall (confidence) | recall (review order)');
  for (const n of [1, 3, 5, 10, 1e9]) {
    const a = topN(byConf, n);
    const b = topN(byReview, n);
    console.log(`${(n > 1e8 ? 'all' : String(n)).padStart(12)} | ${String(a.shown).padStart(5)} | ${pct(a.precision)} | ${pct(b.precision)} | ${pct(a.randomPrecision)} | ${pct(a.recall)} (${a.goldensFound}/${a.goldens}) | ${pct(b.recall)} (${b.goldensFound}/${b.goldens})`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { cases: { type: 'string' }, from: { type: 'string' }, run: { type: 'string' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, 'judge-model': { type: 'string', default: 'claude-sonnet-4-5-20250929' }, prompt: { type: 'string', default: 'v1' }, context: { type: 'boolean', default: false } },
    strict: true,
  });
  if (!values.cases || !values.run) return (console.error(USAGE), 2);
  const all = readJson<MartianCase[]>(values.cases);
  if (cmd === 'rerank' && values.from) {
    const ids = new Set(Object.keys(sourcePredictions(values.from)));
    if (values.prompt !== 'v1' && values.prompt !== 'v2' && values.prompt !== 'fold') return (console.error('--prompt must be v1, v2 or fold'), 2);
    await rerank(all.filter((c) => ids.has(c.id)), values.from, values.run, values.model, { prompt: values.prompt, context: values.context });
    return 0;
  }
  if (cmd === 'topn') {
    const ids = new Set(Object.keys(readJson<Predictions>(join(values.run, 'predictions.json'))));
    topnReport(all.filter((c) => ids.has(c.id)), values.run, values['judge-model']);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main(process.argv.slice(2));
}

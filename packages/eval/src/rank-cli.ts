#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildVerifyPrompt, parseVerdicts, redactSecrets, VERIFY_PROMPT, type Verdict } from '@repospector/core';
import { byConfidence } from '@repospector/extension/engine';
import { candidateText, type BaselineFinding } from './baseline.js';
import type { ReviewJudgement } from './judge.js';
import { ClaudeCliClient } from './llm.js';
import { fetchPrDiff, type MartianCase } from './martian.js';
import { topN, type RankedCase } from './ranking.js';

const USAGE = `usage:
  rank rerank --cases <cases.json> --from <run dir> --run <out dir> [--model claude-sonnet-5-5]
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

async function title(c: MartianCase): Promise<string> {
  const { stdout } = await run('gh', ['api', `repos/${c.repo}/pulls/${c.number}`, '--jq', '.title'], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** Re-runs the (confidence-scoring) verifier over an existing run's findings, in the engine's request shape. */
async function rerank(cases: readonly MartianCase[], from: string, out: string, model: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  const src = sourcePredictions(from);
  const ranksPath = join(out, 'ranks.json');
  const ranks: Record<string, Rank> = existsSync(ranksPath) ? readJson(ranksPath) : {};
  const llm = new ClaudeCliClient(4);
  const todo = cases.filter((c) => (src[c.id]?.findings?.length ?? 0) > 0 && !ranks[c.id]?.verdicts);
  await Promise.all(
    todo.map(async (c) => {
      const findings = src[c.id]?.findings ?? [];
      const prompt = buildVerifyPrompt(await title(c), redactSecrets(await fetchPrDiff(c.repo, c.number)), findings);
      let verdicts: Verdict[] | null = null;
      for (let attempt = 0; attempt < 2 && !verdicts; attempt++) verdicts = parseVerdicts((await llm.complete(prompt, { model, system: '', effort: 'medium' })).text);
      ranks[c.id] = { verdicts };
      writeJson(ranksPath, ranks);
      console.log(`${verdicts ? 'ok ' : 'ERR'} ${c.id} ${findings.length} findings`);
    }),
  );
  const preds: Predictions = {};
  const reviewOrder: Record<string, string[]> = {};
  for (const c of cases) {
    const s = src[c.id];
    if (!s) continue;
    const byIndex = new Map((ranks[c.id]?.verdicts ?? []).map((v) => [v.index, v]));
    const scored = (s.findings ?? []).map((f, i) => ({ f, keep: byIndex.get(i)?.keep ?? true, confidence: byIndex.get(i)?.confidence }));
    const ranked = byConfidence(scored);
    // Same order as the engine: by confidence, then refuted ones below the rest.
    const ordered = [...ranked.filter((r) => r.keep), ...ranked.filter((r) => !r.keep)];
    preds[c.id] = s.findings ? { findings: ordered.map((r) => r.f), truncated: Boolean(s.truncated) } : { findings: null, error: s.error ?? 'not run' };
    reviewOrder[c.id] = (s.findings ?? []).map(candidateText);
  }
  writeJson(join(out, 'predictions.json'), preds);
  writeJson(join(out, 'review-order.json'), reviewOrder);
  writeJson(join(out, 'manifest.json'), { reviewer: `rerank of ${from}`, verifier: model, effort: 'medium', system: 'none', verifyPromptSha: sha(VERIFY_PROMPT), order: 'confidence desc, refuted last' });
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
    options: { cases: { type: 'string' }, from: { type: 'string' }, run: { type: 'string' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, 'judge-model': { type: 'string', default: 'claude-sonnet-4-5-20250929' } },
    strict: true,
  });
  if (!values.cases || !values.run) return (console.error(USAGE), 2);
  const all = readJson<MartianCase[]>(values.cases);
  if (cmd === 'rerank' && values.from) {
    const ids = new Set(Object.keys(sourcePredictions(values.from)));
    await rerank(all.filter((c) => ids.has(c.id)), values.from, values.run, values.model);
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

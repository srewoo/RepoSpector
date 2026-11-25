import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { newRun, runReview, type RepoContext, type RunRecord } from '@repospector/extension/engine';
import type { BaselineFinding } from './baseline.js';
import type { LlmClient } from './llm.js';
import { fetchPrDiff, type MartianCase } from './martian.js';

const run = promisify(execFile);

/**
 * Scores the extension's own pipeline (engine.ts: redaction, measured prompts, labelling verifier)
 * with the model reached through `claude -p` instead of the SDK. Same request shape as the extension
 * (no system prompt, effort high for review / medium for verify); no refusal fallback.
 */
function cliProvider(llm: LlmClient, model: string) {
  return {
    id: 'anthropic' as const,
    model,
    async complete(req: { prompt: string; maxTokens: number; effort?: 'low' | 'medium' | 'high' }) {
      const r = await llm.complete(req.prompt, { model, system: '', ...(req.effort ? { effort: req.effort } : {}) });
      return { text: r.text, model, usage: { inputTokens: 0, outputTokens: 0 }, stop: 'end' as const, fallbackUsed: false };
    },
  };
}

function ghHost(c: MartianCase) {
  return {
    async info() {
      const { stdout } = await run('gh', ['api', `repos/${c.repo}/pulls/${c.number}`, '--jq', '{sha: .head.sha, title: .title}'], { maxBuffer: 1024 * 1024 });
      const j = JSON.parse(stdout) as { sha: string; title: string };
      return { headSha: j.sha, title: j.title };
    },
    diff: () => fetchPrDiff(c.repo, c.number),
  };
}

interface Entry {
  readonly findings: BaselineFinding[] | null;
  readonly truncated: boolean;
  readonly error?: string;
  readonly statuses?: string[];
}

/** Writes <run>/all/predictions.json and <run>/verified/predictions.json; resumable per case. */
type RepoContextFor = (c: MartianCase) => (input: { readonly diff: string; readonly headSha: string }) => Promise<RepoContext>;

export async function runExtensionPipeline(cases: readonly MartianCase[], runDir: string, model: string, llm: LlmClient, repoContextFor?: RepoContextFor, reviewPrompt?: { readonly name: string; readonly text: string }): Promise<void> {
  const records = join(runDir, 'records.json');
  mkdirSync(join(runDir, 'all'), { recursive: true });
  mkdirSync(join(runDir, 'verified'), { recursive: true });
  const done: Record<string, RunRecord> = existsSync(records) ? (JSON.parse(readFileSync(records, 'utf8')) as Record<string, RunRecord>) : {};
  await Promise.all(
    cases.map(async (c) => {
      if (done[c.id]?.status === 'done') return;
      const [owner = '', repo = ''] = c.repo.split('/');
      const target = { kind: 'github' as const, host: 'github.com', owner, repo, number: c.number };
      const provider = cliProvider(llm, model);
      const result = await runReview(newRun(`case-${c.number}`, target, provider, Date.now()), { host: ghHost(c), provider, prices: null, feedback: [], ...(repoContextFor ? { repoContext: repoContextFor(c) } : {}), ...(reviewPrompt ? { reviewPrompt: reviewPrompt.text } : {}), save: async () => undefined, now: () => Date.now() });
      done[c.id] = result;
      writeFileSync(records, `${JSON.stringify(done, null, 2)}\n`);
      console.log(`${result.status === 'done' ? 'ok ' : 'ERR'} ${c.id} ${result.findings?.length ?? result.error?.message}${result.repoContext ? ` defs ${result.repoContext.definitions}/${result.repoContext.indexedFiles} files` : ''}`);
    }),
  );
  const write = (dir: string, keep: (s: string) => boolean): void => {
    const preds: Record<string, Entry> = {};
    for (const c of cases) {
      const r = done[c.id];
      preds[c.id] =
        r?.status === 'done'
          ? { findings: (r.findings ?? []).filter((f) => keep(f.status)).map((f) => ({ file: f.file, line: f.line, claim: f.claim })), truncated: r.notes.some((n) => n.startsWith('The diff is larger')), statuses: (r.findings ?? []).map((f) => f.status) }
          : { findings: null, truncated: false, error: r?.error?.message ?? 'not run' };
    }
    writeFileSync(join(runDir, dir, 'predictions.json'), `${JSON.stringify(preds, null, 2)}\n`);
  };
  write('all', () => true);
  write('verified', (s) => s === 'verified');
  const manifest = { reviewPrompt: reviewPrompt?.name ?? 'baseline', reviewer: repoContextFor ? 'extension engine with repository context via claude -p' : 'extension engine via claude -p', model, effort: { review: 'high', verify: 'medium' }, system: 'none', fallbacks: 'none (CLI)', cases: cases.map((c) => c.id) };
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

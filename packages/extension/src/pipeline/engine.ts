import {
  applyFeedback,
  BASELINE_PROMPT,
  buildDefinitionsPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  DEFINITIONS_ADDENDUM,
  DEFINITIONS_MAX_CHARS,
  mergePasses,
  fingerprint,
  MAX_DIFF_CHARS,
  parseBaselineReply,
  parseUnifiedDiff,
  parseVerdicts,
  RECALL_PROMPT,
  redactSecrets,
  type BaselineFinding,
  type FeedbackEntry,
  type MeaningMatch,
  type ReviewTarget,
  VERIFY_PROMPT,
} from '@repospector/core';
import { estimateCost, type ModelChoice } from '../providers/presets.js';
import { ProviderError, type Effort, type ModelProvider } from '../providers/types.js';
import { ciFindings, extrasNotes, extrasRecord, incrementalReview, runExtraPasses } from './passes.js';
import type { FindingSource, PrExtras, RepoContext, ReviewFinding, RunError, RunRecord } from './run-types.js';

export type { ContextState, FindingSource, PostRecord, PrExtras, RepoContext, ReviewFinding, RunError, RunRecord, RunStatus, Step } from './run-types.js';

export interface EngineDeps {
  readonly host: { info(): Promise<{ headSha: string; title?: string }>; diff(): Promise<string> };
  readonly provider: ModelProvider;
  readonly prices: ModelChoice | null;
  readonly feedback: readonly FeedbackEntry[];
  /** Meaning-based feedback matching (opt-in): builds a matcher for these texts. Word overlap is always used too. */
  readonly meaning?: ((texts: readonly string[]) => Promise<MeaningMatch>) | undefined;
  /**
   * Repository context (default on): code, at the PR head, of what the diff calls, constructs or
   * extends. Throws an Error whose message says why it is unavailable; the review then uses the diff only.
   */
  readonly repoContext?: ((input: { readonly diff: string; readonly headSha: string }) => Promise<RepoContext>) | undefined;
  /** Rules at the PR base, linked issues and CI results. Throws → the review goes on without them. */
  readonly extras?: ((headSha: string) => Promise<PrExtras>) | undefined;
  /** The last finished review of this pull request, for a re-review of only what changed since. */
  readonly previous?: { readonly headSha: string; readonly findings: readonly ReviewFinding[] } | undefined;
  /** Paths changed between two commits, or null when that cannot be trusted (force-push): review it all. */
  readonly changedSince?: ((from: string, to: string) => Promise<string[] | null>) | undefined;
  /** Review-pass instructions; default RECALL_PROMPT (measured 2026-11-24, see PLAN.md). Eval arms pass others. */
  readonly reviewPrompt?: string | undefined;
  readonly save: (run: RunRecord) => Promise<void>;
  readonly now: () => number;
}

const MAX_TOKENS = 16_000;
const UNREADABLE_VERIFY = 'The verifier reply could not be read, so findings are shown unchecked.';

export function newRun(id: string, target: ReviewTarget, provider: ModelProvider, now: number): RunRecord {
  return { id, target, provider: provider.id, model: provider.model, status: 'running', step: 'fetch', startedAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, notes: [] };
}

class ReplyError extends Error {}

function toRunError(e: unknown): RunError {
  if (e instanceof ProviderError) return { kind: e.kind, message: e.message, retryable: e.retryable };
  if (e instanceof ReplyError) return { kind: 'reply', message: e.message, retryable: true };
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number') return { kind: status === 401 || status === 403 ? 'auth' : 'host', message: (e as Error).message, retryable: status >= 500 || status === 429 };
  return { kind: 'unknown', message: (e as Error).message || 'Unknown error', retryable: true };
}

/** Highest confidence first; findings without a score after scored ones; ties keep the review's order. */
export function byConfidence<T extends { readonly confidence?: number | undefined }>(findings: readonly T[]): T[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => (b.f.confidence ?? -1) - (a.f.confidence ?? -1) || a.i - b.i).map(({ f }) => f);
}

const CATEGORY: Record<FindingSource, ReviewFinding['category']> = { review: 'logic', context: 'logic', rules: 'rules', requirements: 'requirements', ci: 'ci' };

/**
 * The pipeline: fetch the diff (only files changed since the last review, when there is one), redact
 * secrets, read rules / linked issues / CI, read repository context, the measured review pass plus
 * the context, rules and linked-issue passes (merged) and a walkthrough, a verifier that labels
 * (never drops), then the team's feedback filter. Saves at every step so a run can resume.
 */
export async function runReview(input: RunRecord, d: EngineDeps): Promise<RunRecord> {
  let run: RunRecord = { ...input, status: 'running', error: undefined };
  let checksError: string | undefined;
  const save = async (patch: Partial<RunRecord>): Promise<void> => {
    run = { ...run, ...patch, updatedAt: d.now() };
    await d.save(run);
  };
  const call = async (prompt: string, effort: Effort): Promise<string> => {
    const r = await d.provider.complete({ prompt, maxTokens: MAX_TOKENS, effort });
    const usage = { inputTokens: run.usage.inputTokens + r.usage.inputTokens, outputTokens: run.usage.outputTokens + r.usage.outputTokens };
    run = { ...run, usage, costUsd: d.prices ? estimateCost(d.prices, usage.inputTokens, usage.outputTokens) : null, modelsUsed: [...new Set([...(run.modelsUsed ?? []), r.model])] };
    if (r.stop === 'refusal') throw new ProviderError('bad_request', `${r.model} declined to review this change. Try another model in settings.`);
    return r.text;
  };

  try {
    await save({ step: 'fetch' });
    const info = await d.host.info();
    if (run.headSha !== info.headSha || run.diff === undefined) {
      let diff = redactSecrets(await d.host.diff());
      const notes = diff.length > MAX_DIFF_CHARS ? [`The diff is larger than ${MAX_DIFF_CHARS / 1000}k characters; only the first ${MAX_DIFF_CHARS / 1000}k were reviewed.`] : [];
      let incremental: RunRecord['incremental'];
      let carried: ReviewFinding[] | undefined;
      const prev = d.previous;
      if (prev && prev.headSha !== info.headSha && d.changedSince) {
        const changed = await d.changedSince(prev.headSha, info.headSha);
        if (changed) {
          const inc = incrementalReview(diff, changed, prev.findings);
          diff = inc.diff;
          carried = inc.carried;
          incremental = { since: prev.headSha, files: inc.files, carried: inc.carried.length };
        } else notes.push('The pull request history changed since the last review (or the host could not compare), so everything was reviewed again.');
      }
      run = { ...run, headSha: info.headSha, title: info.title ?? '', diff, filesReviewed: parseUnifiedDiff(diff).length, review: undefined, repoContext: undefined, contextReview: undefined, extras: undefined, rulesReview: undefined, requirementsReview: undefined, summary: undefined, verdicts: undefined, findings: undefined, incremental, carried, notes };
    }
    if (run.extras === undefined && d.extras && run.headSha) {
      try {
        const x = await d.extras(run.headSha);
        checksError = x.checksError;
        run = { ...run, extras: extrasRecord(x) };
      } catch (e) {
        run = { ...run, extras: null, notes: [...run.notes, `Team rules, linked issues and CI results were not read (${(e as Error).message}).`] };
      }
    }
    const title = run.title ?? '';
    const diff = run.diff ?? '';
    const hasDiff = diff.trim().length > 0;

    await save({ step: 'context' });
    if (hasDiff && run.repoContext === undefined && d.repoContext && run.headSha) {
      try {
        const c = await d.repoContext({ diff, headSha: run.headSha });
        run = { ...run, repoContext: c };
      } catch (e) {
        run = { ...run, repoContext: null, notes: [...run.notes, `Repository context was not used (${(e as Error).message}), so this review read the diff only.`] };
      }
    }
    const contextText = run.repoContext?.text ?? '';

    await save({ step: 'review' });
    // The plain pass is the measured review and always runs; the other passes run beside it, never instead.
    const plain = async (): Promise<readonly BaselineFinding[]> => {
      if (run.review || !hasDiff) return run.review ?? [];
      const r = parseBaselineReply(await call(buildReviewPrompt(title, diff, d.reviewPrompt ?? RECALL_PROMPT), 'high'));
      if (!r) throw new ReplyError('The model reply could not be read as a list of findings. Run the review again.');
      return r;
    };
    const withContext = async (): Promise<readonly BaselineFinding[] | undefined> => {
      if (run.contextReview || !contextText) return run.contextReview;
      const r = parseBaselineReply(await call(buildDefinitionsPrompt(title, diff, contextText), 'high'));
      // An unreadable context pass costs that pass only: the plain review still stands.
      if (!r) run = { ...run, notes: [...run.notes, 'The repository-context pass reply could not be read; findings come from the plain review only.'] };
      return r ?? [];
    };
    const [first, second, extra] = await Promise.all([plain(), withContext(), hasDiff ? runExtraPasses(run, title, diff, call) : Promise.resolve({ notes: [] as string[] })]);
    run = { ...run, review: first, ...(second ? { contextReview: second } : {}), ...('summary' in extra ? { summary: extra.summary, rulesReview: extra.rulesReview, requirementsReview: extra.requirementsReview } : {}), notes: [...run.notes, ...extra.notes] };
    // The plain pass is kept whole (as measured); the others merge into it in a fixed order, each finding remembering its pass.
    let review: BaselineFinding[] = [...(run.review ?? [])];
    const sources: FindingSource[] = review.map(() => 'review');
    for (const [src, list] of [['context', run.contextReview], ['rules', run.rulesReview], ['requirements', run.requirementsReview]] as const) {
      const merged = mergePasses(review, list ?? []);
      sources.push(...merged.slice(review.length).map(() => src));
      review = merged;
    }

    await save({ step: 'verify' });
    if (run.verdicts === undefined) {
      // Call first, then copy `run`: call() updates usage, and spreading before it would drop that.
      const verdicts = review.length === 0 ? [] : parseVerdicts(await call(buildVerifyPrompt(title, diff, review), 'medium'));
      run = { ...run, verdicts };
    }

    await save({ step: 'filter' });
    const verdicts = run.verdicts;
    const byIndex = new Map((verdicts ?? []).map((v) => [v.index, v]));
    const labelled: ReviewFinding[] = review.map((f, i) => {
      const v = byIndex.get(i);
      const src = sources[i] ?? 'review';
      const category = CATEGORY[src];
      const status = !verdicts || !v ? 'unchecked' : v.keep ? 'verified' : 'suspected';
      return { id: `f${i + 1}`, file: f.file, line: f.line, claim: f.claim, status, ...(v && !v.keep ? { suspectedBecause: v.reason } : {}), ...(v?.confidence !== undefined ? { confidence: v.confidence } : {}), ...(v?.impact ? { impact: v.impact } : {}), ...(src === 'context' ? { fromContext: true as const } : {}), ...(src === 'rules' || src === 'requirements' ? { source: src } : {}), fingerprint: fingerprint({ file: f.file, category, claim: f.claim }), category };
    });
    const fromCi = ciFindings(run.extras?.checks, diff, labelled.length + 1);
    const fresh = [...labelled, ...fromCi];
    let notes = verdicts === null && review.length > 0 ? [...run.notes, UNREADABLE_VERIFY] : [...run.notes];
    let sameMeaning: MeaningMatch | undefined;
    if (d.meaning && d.feedback.length > 0 && fresh.length > 0) {
      try {
        sameMeaning = await d.meaning([...d.feedback.map((e) => e.claim), ...fresh.map((f) => f.claim)]);
      } catch (e) {
        notes = [...notes, `Meaning-based matching was unavailable (${(e as Error).message}); findings were compared with your feedback by shared words only.`];
      }
    }
    if (run.repoContext?.definitions) notes = [...notes, `Also reviewed with code from other files: ${run.repoContext.definitions} definition${run.repoContext.definitions === 1 ? '' : 's'} of what this change calls, from ${run.repoContext.indexedFiles} indexed files.`];
    else if (run.repoContext) notes = [...notes, 'Read the repository: nothing this change calls is defined elsewhere in it, so no second pass was needed.'];
    if (run.incremental) notes = [...notes, `Re-review: only the ${run.incremental.files} file${run.incremental.files === 1 ? '' : 's'} changed since ${run.incremental.since.slice(0, 7)} were reviewed; ${run.incremental.carried} earlier finding${run.incremental.carried === 1 ? '' : 's'} in other files ${run.incremental.carried === 1 ? 'is' : 'are'} listed after the new ones.`];
    notes = [...notes, ...extrasNotes(run, checksError)];
    // Rank, never delete: most likely first; applyFeedback then moves suspected ones below verified. Earlier findings come last.
    const ranked = [...applyFeedback(byConfidence(fresh), d.feedback, sameMeaning), ...(run.carried ?? [])];
    // The diff, repository code, rules and issue texts are kept only while running (for resume); only counts remain.
    const repoContext = run.repoContext ? { definitions: run.repoContext.definitions, indexedFiles: run.repoContext.indexedFiles } : run.repoContext;
    const extras = run.extras ? { ...run.extras, rulesText: undefined, issuesText: undefined } : run.extras;
    await save({ status: 'done', findings: ranked, notes, diff: undefined, repoContext, extras });
  } catch (e) {
    await save({ status: 'failed', error: toRunError(e) });
  }
  return run;
}

export interface CostEstimate {
  readonly lowUsd: number;
  readonly highUsd: number;
}

/**
 * Rough cost of one review before it runs: plain review pass + verifier + a short walkthrough, plus
 * (with repository context) a second review pass with up to DEFINITIONS_MAX_CHARS of code. ~4
 * characters per token for input; output from a short answer to a long one with thinking. Rules and
 * linked-issue passes, when the pull request has them, add up to one more pass each (not included).
 */
export function estimateReview(diffChars: number, prices: ModelChoice | null, withContext = false): CostEstimate | null {
  if (!prices) return null;
  const diff = Math.min(diffChars, MAX_DIFF_CHARS);
  const base = (BASELINE_PROMPT.length + diff + VERIFY_PROMPT.length + diff + 2_000 + diff) / 4;
  const second = (BASELINE_PROMPT.length + DEFINITIONS_ADDENDUM.length + diff) / 4;
  const low = withContext ? base + second + 2_000 / 4 : base;
  const high = withContext ? base + second + DEFINITIONS_MAX_CHARS / 4 : base;
  return { lowUsd: estimateCost(prices, low, withContext ? 4_000 : 2_500), highUsd: estimateCost(prices, high * 1.2, withContext ? 28_000 : 16_000) };
}

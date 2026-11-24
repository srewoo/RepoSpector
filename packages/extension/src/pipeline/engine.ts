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
  redactSecrets,
  type BaselineFinding,
  type FeedbackEntry,
  type FindingContext,
  type MeaningMatch,
  type ReviewTarget,
  type Verdict,
  VERIFY_PROMPT,
} from '@repospector/core';
import { estimateCost, type ModelChoice } from '../providers/presets.js';
import { ProviderError, type Effort, type ModelProvider, type ProviderId } from '../providers/types.js';

export type RunStatus = 'running' | 'done' | 'failed';
/** The step in progress; data of earlier steps is on the record, so a run resumes from here. */
export type Step = 'fetch' | 'context' | 'review' | 'verify' | 'filter';

export interface ReviewFinding {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly claim: string;
  /** verified: the verifier could not disprove it. suspected: refuted or matches rejected feedback. unchecked: verifier reply unreadable. */
  readonly status: 'verified' | 'suspected' | 'unchecked';
  readonly suspectedBecause?: string | undefined;
  /** The verifier's 0-100 estimate that this is a real defect; findings are ordered by it. */
  readonly confidence?: number | undefined;
  /** The verifier's rating of how bad it is if real. Display only; order stays by confidence. */
  readonly impact?: 'high' | 'medium' | 'low' | undefined;
  /** Set when only the repository-context pass found it (the plain pass did not report it nearby). */
  readonly fromContext?: true | undefined;
  readonly fingerprint: string;
  readonly category: 'logic';
}

export interface RunError {
  readonly kind: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RunRecord {
  readonly id: string;
  readonly target: ReviewTarget;
  readonly provider: ProviderId;
  readonly model: string;
  readonly status: RunStatus;
  readonly step: Step;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Null when the model's price is unknown (custom model id). */
  readonly costUsd: number | null;
  /** Coverage and quality notes shown with the result. */
  readonly notes: readonly string[];
  readonly headSha?: string | undefined;
  readonly title?: string | undefined;
  /** Redacted diff, kept only while the run is in progress (for resume); removed when done. */
  readonly diff?: string | undefined;
  readonly review?: readonly BaselineFinding[] | undefined;
  /**
   * Repository context for the second pass. undefined: not tried yet; null: unavailable (a note says
   * why). `text` (code from other files) is kept only while the run is in progress, like the diff.
   */
  readonly repoContext?: { readonly text?: string | undefined; readonly definitions: number; readonly indexedFiles: number } | null | undefined;
  /** Findings of the repository-context pass, before merging with `review`. */
  readonly contextReview?: readonly BaselineFinding[] | undefined;
  /** null: the verifier replied but the reply was unreadable. */
  readonly verdicts?: readonly Verdict[] | null | undefined;
  readonly findings?: readonly ReviewFinding[] | undefined;
  readonly modelsUsed?: readonly string[] | undefined;
  /** Files in the diff that was reviewed. */
  readonly filesReviewed?: number | undefined;
  readonly error?: RunError | undefined;
  /** Draft posts made from the side panel, newest last. */
  readonly posted?: readonly PostRecord[] | undefined;
  /** Where each finding's code is used, built on request from the repository archive (C8). */
  readonly context?: ContextState | undefined;
}

export type ContextState =
  | { readonly status: 'running'; readonly files: number; readonly downloadedMB: number; readonly startedAt: number }
  | { readonly status: 'done'; readonly source: 'saved' | 'changed-files' | 'download' | 'local'; readonly files: number; readonly skipped: number; readonly reused: number; readonly ms: number; readonly perFinding: Readonly<Record<string, FindingContext>> }
  | { readonly status: 'failed'; readonly message: string };

export interface RepoContext {
  readonly text: string;
  readonly definitions: number;
  readonly indexedFiles: number;
}

export interface PostRecord {
  readonly at: number;
  readonly url: string;
  /** Findings now on the pull request: posted inline, in the summary, or found there already. */
  readonly findingIds: readonly string[];
}

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

/**
 * The pipeline: fetch the diff, redact secrets, read repository context (code of what the diff
 * calls), the measured review pass plus a second pass with that context (merged), a verifier that
 * labels (never drops), then the team's feedback filter. Saves the record at every step so a run can resume.
 */
export async function runReview(input: RunRecord, d: EngineDeps): Promise<RunRecord> {
  let run: RunRecord = { ...input, status: 'running', error: undefined };
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
      const diff = redactSecrets(await d.host.diff());
      const notes = diff.length > MAX_DIFF_CHARS ? [`The diff is larger than ${MAX_DIFF_CHARS / 1000}k characters; only the first ${MAX_DIFF_CHARS / 1000}k were reviewed.`] : [];
      run = { ...run, headSha: info.headSha, title: info.title ?? '', diff, filesReviewed: parseUnifiedDiff(diff).length, review: undefined, repoContext: undefined, contextReview: undefined, verdicts: undefined, findings: undefined, notes };
    }
    const title = run.title ?? '';
    const diff = run.diff ?? '';

    await save({ step: 'context' });
    if (run.repoContext === undefined && d.repoContext && run.headSha) {
      try {
        const c = await d.repoContext({ diff, headSha: run.headSha });
        run = { ...run, repoContext: c };
      } catch (e) {
        run = { ...run, repoContext: null, notes: [...run.notes, `Repository context was not used (${(e as Error).message}), so this review read the diff only.`] };
      }
    }
    const contextText = run.repoContext?.text ?? '';

    await save({ step: 'review' });
    // The plain pass is the measured review and always runs; the context pass runs beside it, never instead.
    const plain = async (): Promise<readonly BaselineFinding[]> => {
      if (run.review) return run.review;
      const r = parseBaselineReply(await call(buildReviewPrompt(title, diff), 'high'));
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
    const [first, second] = await Promise.all([plain(), withContext()]);
    run = { ...run, review: first, ...(second ? { contextReview: second } : {}) };
    const fromPlain = run.review ?? [];
    const review = mergePasses(fromPlain, run.contextReview ?? []);

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
      const status = !verdicts || !v ? 'unchecked' : v.keep ? 'verified' : 'suspected';
      return { id: `f${i + 1}`, file: f.file, line: f.line, claim: f.claim, status, ...(v && !v.keep ? { suspectedBecause: v.reason } : {}), ...(v?.confidence !== undefined ? { confidence: v.confidence } : {}), ...(v?.impact ? { impact: v.impact } : {}), ...(i >= fromPlain.length ? { fromContext: true as const } : {}), fingerprint: fingerprint({ file: f.file, category: 'logic', claim: f.claim }), category: 'logic' };
    });
    let notes = verdicts === null && review.length > 0 ? [...run.notes, UNREADABLE_VERIFY] : run.notes;
    let sameMeaning: MeaningMatch | undefined;
    if (d.meaning && d.feedback.length > 0 && labelled.length > 0) {
      try {
        sameMeaning = await d.meaning([...d.feedback.map((e) => e.claim), ...labelled.map((f) => f.claim)]);
      } catch (e) {
        notes = [...notes, `Meaning-based matching was unavailable (${(e as Error).message}); findings were compared with your feedback by shared words only.`];
      }
    }
    // Rank, never delete: most likely first; applyFeedback then moves suspected ones below verified.
    if (run.repoContext?.definitions) notes = [...notes, `Also reviewed with code from other files: ${run.repoContext.definitions} definition${run.repoContext.definitions === 1 ? '' : 's'} of what this change calls, from ${run.repoContext.indexedFiles} indexed files.`];
    else if (run.repoContext) notes = [...notes, 'Read the repository: nothing this change calls is defined elsewhere in it, so no second pass was needed.'];
    // The diff and repository code are kept only while running (for resume); only counts remain.
    const repoContext = run.repoContext ? { definitions: run.repoContext.definitions, indexedFiles: run.repoContext.indexedFiles } : run.repoContext;
    await save({ status: 'done', findings: applyFeedback(byConfidence(labelled), d.feedback, sameMeaning), notes, diff: undefined, repoContext });
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
 * Rough cost of one review before it runs: plain review pass + verifier, plus (with repository
 * context) a second review pass with up to DEFINITIONS_MAX_CHARS of code. ~4 characters per token
 * for input; output from a short answer to a long one with thinking. Null when the price is unknown.
 */
export function estimateReview(diffChars: number, prices: ModelChoice | null, withContext = false): CostEstimate | null {
  if (!prices) return null;
  const diff = Math.min(diffChars, MAX_DIFF_CHARS);
  const base = (BASELINE_PROMPT.length + diff + VERIFY_PROMPT.length + diff + 2_000) / 4;
  const second = (BASELINE_PROMPT.length + DEFINITIONS_ADDENDUM.length + diff) / 4;
  const low = withContext ? base + second + 2_000 / 4 : base;
  const high = withContext ? base + second + DEFINITIONS_MAX_CHARS / 4 : base;
  return { lowUsd: estimateCost(prices, low, withContext ? 3_000 : 1_500), highUsd: estimateCost(prices, high * 1.2, withContext ? 24_000 : 12_000) };
}

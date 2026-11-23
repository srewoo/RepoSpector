import {
  applyFeedback,
  BASELINE_PROMPT,
  buildReviewPrompt,
  buildVerifyPrompt,
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
export type Step = 'fetch' | 'review' | 'verify' | 'filter';

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
 * The measured pipeline: fetch the diff, redact secrets, one review pass, a verifier that labels
 * (never drops), then the team's feedback filter. Saves the record at every step so a run can resume.
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
      run = { ...run, headSha: info.headSha, title: info.title ?? '', diff, filesReviewed: parseUnifiedDiff(diff).length, review: undefined, verdicts: undefined, findings: undefined, notes };
    }
    const title = run.title ?? '';
    const diff = run.diff ?? '';

    await save({ step: 'review' });
    if (!run.review) {
      const review = parseBaselineReply(await call(buildReviewPrompt(title, diff), 'high'));
      if (!review) throw new ReplyError('The model reply could not be read as a list of findings. Run the review again.');
      run = { ...run, review };
    }
    const review = run.review ?? [];

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
      return { id: `f${i + 1}`, file: f.file, line: f.line, claim: f.claim, status, ...(v && !v.keep ? { suspectedBecause: v.reason } : {}), ...(v?.confidence !== undefined ? { confidence: v.confidence } : {}), fingerprint: fingerprint({ file: f.file, category: 'logic', claim: f.claim }), category: 'logic' };
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
    await save({ status: 'done', findings: applyFeedback(byConfidence(labelled), d.feedback, sameMeaning), notes, diff: undefined });
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
 * Rough cost of one review (review pass + verifier) before it runs: ~4 characters per token for
 * input; output from a short answer to a long one with thinking. Null when the price is unknown.
 */
export function estimateReview(diffChars: number, prices: ModelChoice | null): CostEstimate | null {
  if (!prices) return null;
  const diff = Math.min(diffChars, MAX_DIFF_CHARS);
  const inputTokens = (BASELINE_PROMPT.length + diff + VERIFY_PROMPT.length + diff + 2_000) / 4;
  return { lowUsd: estimateCost(prices, inputTokens, 1_500), highUsd: estimateCost(prices, inputTokens * 1.2, 12_000) };
}

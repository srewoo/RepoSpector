import type { BaselineFinding, CiCheck, FindingContext, LinkedIssue, PrSummary, ReviewTarget, SuggestedFix, Verdict } from '@repospector/core';
import type { ProviderId } from '../providers/types.js';

export type RunStatus = 'running' | 'done' | 'failed';
/** The step in progress; data of earlier steps is on the record, so a run resumes from here. */
export type Step = 'fetch' | 'context' | 'review' | 'verify' | 'filter';

/** Which pass found it: the plain review, the repository-context pass, the team-rules pass, the linked-issue pass, or CI. */
export type FindingSource = 'review' | 'context' | 'rules' | 'requirements' | 'ci';

export interface ReviewFinding {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly claim: string;
  /** verified: the verifier could not disprove it (or a CI tool reported it). suspected: refuted or matches rejected feedback. unchecked: verifier reply unreadable. */
  readonly status: 'verified' | 'suspected' | 'unchecked';
  readonly suspectedBecause?: string | undefined;
  /** The verifier's 0-100 estimate that this is a real defect; findings are ordered by it. */
  readonly confidence?: number | undefined;
  /** The verifier's rating of how bad it is if real. Display only; order stays by confidence. */
  readonly impact?: 'high' | 'medium' | 'low' | undefined;
  /** Set when only the repository-context pass found it (the plain pass did not report it nearby). */
  readonly fromContext?: true | undefined;
  /** Set for findings of the rules, linked-issue or CI passes. Absent: the plain review or context pass. */
  readonly source?: Exclude<FindingSource, 'review' | 'context'> | undefined;
  /** From the previous review of this pull request, in a file the new commits did not touch. */
  readonly carried?: true | undefined;
  /** A suggested change, made on request; posted as a one-click suggestion. */
  readonly fix?: SuggestedFix | undefined;
  /** Why no fix was suggested when one was asked for. */
  readonly fixUnavailable?: string | undefined;
  readonly fingerprint: string;
  readonly category: 'logic' | 'rules' | 'requirements' | 'ci';
}

export interface RunError {
  readonly kind: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface PostRecord {
  readonly at: number;
  readonly url: string;
  /** Findings now on the pull request: posted inline, in the summary, or found there already. */
  readonly findingIds: readonly string[];
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

/** What else the pull request offers besides its diff: rules at its base, linked issues, CI results. */
export interface PrExtras {
  readonly rules: { readonly text: string; readonly files: readonly string[] };
  readonly issues: readonly LinkedIssue[];
  /** Jira-style keys mentioned but not readable from the git host. */
  readonly ticketKeys: readonly string[];
  /** Null when the host refused or CI could not be read; `checksError` says why. */
  readonly checks: readonly CiCheck[] | null;
  readonly checksError?: string | undefined;
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
  /** PR description (untrusted), kept only while running; the review pass reads it. */
  readonly description?: string | undefined;
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
  /** Rules, linked issues and CI results; texts are dropped when the run is done, names and counts stay. */
  readonly extras?: { readonly rulesText?: string | undefined; readonly rulesFiles: readonly string[]; readonly issuesText?: string | undefined; readonly issueRefs: readonly string[]; readonly ticketKeys: readonly string[]; readonly checks: readonly CiCheck[] | null } | null | undefined;
  readonly rulesReview?: readonly BaselineFinding[] | undefined;
  readonly requirementsReview?: readonly BaselineFinding[] | undefined;
  /** Walkthrough of the change. null: the summary reply was unreadable. */
  readonly summary?: PrSummary | null | undefined;
  /** Re-review: only files changed since an earlier reviewed head were reviewed. */
  readonly incremental?: { readonly since: string; readonly files: number; readonly carried: number } | undefined;
  /** Earlier findings in untouched files, shown after the new ones. */
  readonly carried?: readonly ReviewFinding[] | undefined;
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

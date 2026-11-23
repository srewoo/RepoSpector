import { feedbackEntry, type ReviewTarget } from '@repospector/core';
import type { ReviewFinding } from '../pipeline/engine.js';
import type { FeedbackChoice, FeedbackRow } from '../pipeline/store.js';

export const CHOICE_LABELS: Record<FeedbackChoice, string> = { useful: 'Useful', 'not-useful': 'Not useful', 'not-relevant': 'Not relevant here' };

export function repoOf(t: ReviewTarget): string {
  return t.kind === 'github' ? `${t.host}/${t.owner}/${t.repo}` : `${t.host}/${t.project}`;
}

/**
 * Maps a reaction in the panel to the shared feedback format: "Useful" is accepted; "Not useful"
 * and "Not relevant here" are rejected, the latter with that phrase leading the reason so an
 * exported file keeps the distinction. The extension has no severity per finding, so it records medium.
 */
export function feedbackRow(f: ReviewFinding, choice: FeedbackChoice, reason: string, target: ReviewTarget, at: Date): FeedbackRow {
  const why = reason.trim();
  const text = choice === 'not-relevant' ? `Not relevant here${why ? `: ${why}` : ''}` : why;
  const entry = feedbackEntry({ fingerprint: f.fingerprint, category: f.category, severity: 'medium', claim: f.claim, file: f.file }, choice === 'useful' ? 'accepted' : 'rejected', text, at);
  return { key: f.fingerprint, choice, repo: repoOf(target), entry };
}

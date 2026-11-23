import { z } from 'zod';
import { CATEGORIES, SEVERITIES, type Category, type JudgedFinding } from './finding.js';
import { redactSecrets } from './untrusted.js';

/**
 * A team's reaction to a finding. Stored locally, and shared through `.RepoSpector/feedback.jsonl`
 * in the repo when the team exports it. Holds the claim text so similar future findings match.
 */
export const FeedbackEntrySchema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    claim: z.string().min(1).max(1000),
    file: z.string().min(1).max(500),
    reaction: z.enum(['accepted', 'rejected']),
    reason: z.string().max(500),
    at: z.iso.datetime(),
  })
  .strict();

export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;
export type Reaction = FeedbackEntry['reaction'];

/** Rejections of similar comments needed before a finding is demoted (spec: 3). */
export const SIMILAR_REJECTIONS = 3;
/** Word-overlap (Jaccard) needed to call two claims similar. A stand-in for embeddings. */
export const SIMILARITY = 0.5;

export function feedbackEntry(f: Pick<JudgedFinding, 'fingerprint' | 'category' | 'severity' | 'claim' | 'file'>, reaction: Reaction, reason: string, at: Date): FeedbackEntry {
  return {
    fingerprint: f.fingerprint,
    category: f.category,
    severity: f.severity,
    claim: redactSecrets(f.claim).slice(0, 1000),
    file: f.file,
    reaction,
    reason: redactSecrets(reason).slice(0, 500),
    at: at.toISOString(),
  };
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'this', 'that', 'be', 'may', 'could', 'can', 'on', 'for', 'with', 'by', 'as', 'at']);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** What the team filter needs from a finding; MCP's JudgedFinding and the extension's findings both fit. */
export interface FilterableFinding {
  readonly fingerprint: string;
  readonly category: Category;
  readonly claim: string;
  readonly status: string;
  readonly suspectedBecause?: string | undefined;
}

/** Extra "same meaning" test, e.g. sentence embeddings; used in addition to word overlap. */
export type MeaningMatch = (a: string, b: string) => boolean;

function demotion(f: FilterableFinding, entries: readonly FeedbackEntry[], sameMeaning?: MeaningMatch): string | undefined {
  if (entries.some((e) => e.reaction === 'rejected' && e.fingerprint === f.fingerprint)) return 'your team rejected this same finding before';
  const near = entries.filter((e) => e.category === f.category && (similarity(e.claim, f.claim) >= SIMILARITY || sameMeaning?.(e.claim, f.claim) === true));
  const rejectedCount = near.filter((e) => e.reaction === 'rejected').length;
  const acceptedCount = near.length - rejectedCount;
  if (rejectedCount >= SIMILAR_REJECTIONS && rejectedCount > acceptedCount) return `similar to ${rejectedCount} comments your team rejected`;
  return undefined;
}

/**
 * The team filter. Matching findings are demoted to suspected with the reason, never removed:
 * real bugs matter more than avoiding noise. Verified findings come first.
 */
export function applyFeedback<T extends FilterableFinding>(findings: readonly T[], entries: readonly FeedbackEntry[], sameMeaning?: MeaningMatch): T[] {
  const out = findings.map((f) => {
    if (f.status === 'suspected') return f;
    const why = demotion(f, entries, sameMeaning);
    return why ? { ...f, status: 'suspected' as const, suspectedBecause: why } : f;
  });
  return [...out.filter((f) => f.status !== 'suspected'), ...out.filter((f) => f.status === 'suspected')];
}

/** One JSON object per line. Malformed or unknown-shaped lines are skipped, not fatal. */
export function parseFeedbackJsonl(text: string): FeedbackEntry[] {
  const out: FeedbackEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = FeedbackEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function toFeedbackJsonl(entries: readonly FeedbackEntry[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

const key = (e: FeedbackEntry): string => `${e.fingerprint}|${e.reaction}|${e.at}`;

/** Union by (fingerprint, reaction, time), oldest first. */
export function mergeFeedback(a: readonly FeedbackEntry[], b: readonly FeedbackEntry[]): FeedbackEntry[] {
  const byKey = new Map<string, FeedbackEntry>();
  for (const e of [...a, ...b]) byKey.set(key(e), e);
  return [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at));
}

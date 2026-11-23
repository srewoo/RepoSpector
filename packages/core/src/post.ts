import { parseUnifiedDiff } from './diff.js';
import type { JudgedFinding } from './finding.js';
import { redactSecrets } from './untrusted.js';

/** Inclusive new-file line ranges per path where a host accepts an inline comment. */
export type PostableHunks = Map<string, [number, number][]>;

export interface PlannedComment {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface PostPlan {
  readonly inline: PlannedComment[];
  /** Findings with no line in the PR diff: listed in the review summary instead. */
  readonly inSummary: { readonly findingId: string; readonly reason: string }[];
  /** Findings whose marker is already on the PR (posted earlier, as draft or comment). */
  readonly alreadyPosted: string[];
  readonly summary: string;
}

const MAX_TEXT = 3000;

/**
 * What posting needs from a finding. MCP's JudgedFinding maps onto it with `fromJudged`; the
 * extension builds it from its own findings. Model-written text is cleaned here, not by callers.
 */
export interface PostableFinding {
  readonly id: string;
  readonly fingerprint: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly claim: string;
  readonly status: string;
  readonly suspectedBecause?: string | undefined;
  /** Shown after "RepoSpector" in the label, e.g. severity and category. */
  readonly tags: readonly string[];
  /** Model-written explanation for a collapsed "Why" section. */
  readonly why?: string | undefined;
  /** Other lines to anchor on when the finding's own lines are outside the diff. */
  readonly evidence?: readonly { readonly file: string; readonly startLine: number; readonly endLine: number }[];
}

export function fromJudged(f: JudgedFinding): PostableFinding {
  return {
    id: f.id,
    fingerprint: f.fingerprint,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
    claim: f.claim,
    status: f.status,
    suspectedBecause: f.suspectedBecause,
    tags: [f.severity, f.category],
    why: `${f.reasoning}\n\nVerifier: ${f.verdict.reason}`,
    evidence: f.evidence,
  };
}

/** Hidden marker that makes posting idempotent: one per finding fingerprint. */
export function markerFor(fingerprint: string): string {
  return `<!-- repospector:${fingerprint.replace(/[^\w-]/g, '')} -->`;
}

export const MARKER_RE = /<!-- repospector:([\w-]+) -->/g;

/** Model-written text: no notifications, no hidden or fake markers, no secrets, bounded length. */
function clean(text: string): string {
  return redactSecrets(text)
    .replace(/<!--|-->/g, (m) => m.split('').join('​'))
    .replace(/(^|[^\w`])@(?=[\w-])/g, '$1@​')
    .slice(0, MAX_TEXT);
}

export function postableHunks(diffText: string): PostableHunks {
  const out: PostableHunks = new Map();
  for (const f of parseUnifiedDiff(diffText)) {
    if (f.status === 'deleted' || f.binary) continue;
    out.set(
      f.path,
      f.hunks.filter((h) => h.newLines > 0).map((h) => [h.newStart, h.newStart + h.newLines - 1] as [number, number]),
    );
  }
  return out;
}

const inHunks = (hunks: PostableHunks, path: string, line: number): boolean => (hunks.get(path) ?? []).some(([a, b]) => line >= a && line <= b);

function label(f: PostableFinding): string {
  const status = f.status === 'verified' ? 'verified' : `suspected${f.suspectedBecause ? ` (${clean(f.suspectedBecause)})` : ''}`;
  return ['**RepoSpector**', ...f.tags.map(clean), status].join(' · ');
}

export function commentBody(f: PostableFinding): string {
  return [label(f), '', clean(f.claim), '', ...(f.why ? [`<details><summary>Why</summary>\n\n${clean(f.why)}\n</details>`, ''] : []), markerFor(f.fingerprint)].join('\n');
}

/** Last line of the finding in the diff, else its first, else any evidence line in the same file. */
function anchor(f: PostableFinding, hunks: PostableHunks): { path: string; line: number } | undefined {
  for (const line of [f.endLine, f.startLine]) if (inHunks(hunks, f.file, line)) return { path: f.file, line };
  for (const e of f.evidence ?? []) for (const line of [e.endLine, e.startLine]) if (inHunks(hunks, e.file, line)) return { path: e.file, line };
  return undefined;
}

export function buildPostPlan(findings: readonly PostableFinding[], hunks: PostableHunks, existing: ReadonlySet<string>): PostPlan {
  const inline: PlannedComment[] = [];
  const inSummary: PostPlan['inSummary'] = [];
  const alreadyPosted: string[] = [];
  const summaryLines: string[] = [];
  for (const f of findings) {
    if (existing.has(f.fingerprint)) {
      alreadyPosted.push(f.id);
      continue;
    }
    const at = anchor(f, hunks);
    if (at) inline.push({ findingId: f.id, ...at, body: commentBody(f) });
    else {
      inSummary.push({ findingId: f.id, reason: 'no line of this finding is in the PR diff' });
      summaryLines.push(`- \`${f.file}:${f.startLine}\` · ${[...f.tags.map(clean), clean(f.claim)].join(' · ')} ${markerFor(f.fingerprint)}`);
    }
  }
  const total = inline.length + inSummary.length;
  const summary = [
    `**RepoSpector review**: ${total} finding(s), ${inline.length} inline.${alreadyPosted.length ? ` ${alreadyPosted.length} already posted earlier.` : ''}`,
    ...(summaryLines.length ? ['', 'Outside the changed lines:', ...summaryLines] : []),
    '',
    '<sub>Drafted by RepoSpector and verified by a second agent. Review before publishing.</sub>',
  ].join('\n');
  return { inline, inSummary, alreadyPosted, summary };
}

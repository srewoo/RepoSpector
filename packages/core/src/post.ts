import { parseUnifiedDiff } from './diff.js';
import type { JudgedFinding } from './finding.js';
import { redactSecrets } from './untrusted.js';

/** Inclusive new-file line ranges per path where a host accepts an inline comment. */
export type PostableHunks = Map<string, [number, number][]>;

export interface PlannedComment {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  /** First line of a multi-line comment (a suggested change spanning several lines). */
  readonly startLine?: number | undefined;
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
  /** A suggested change to lines of `file` at the reviewed commit; posted as a one-click suggestion when they are in one diff hunk. */
  readonly fix?: { readonly startLine: number; readonly endLine: number; readonly replacement: string } | undefined;
}

/** Host comment syntax for suggested changes. */
export type HostFlavor = 'github' | 'gitlab';

export interface PostOptions {
  readonly flavor?: HostFlavor | undefined;
  /** At most this many inline comments, in the given order (callers pass findings most likely first); the rest are listed in the summary. Default 15. */
  readonly maxInline?: number | undefined;
  /** Markdown walkthrough placed at the top of the review body (model text: cleaned here). */
  readonly walkthrough?: string | undefined;
  /** Extra summary lines (e.g. CI results), already plain text. */
  readonly extra?: readonly string[] | undefined;
}

export const DEFAULT_MAX_INLINE = 15;

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
    fix: f.fix,
  };
}

/** Hidden marker that makes posting idempotent: one per finding fingerprint. */
export function markerFor(fingerprint: string): string {
  return `<!-- repospector:${fingerprint.replace(/[^\w-]/g, '')} -->`;
}

export const MARKER_RE = /<!-- repospector:([\w-]+) -->/g;

/** Model-written text: no notifications, no hidden or fake markers, no secrets, bounded length. */
function clean(text: string, max = MAX_TEXT): string {
  return redactSecrets(text)
    .replace(/<!--|-->/g, (m) => m.split('').join('​'))
    .replace(/(^|[^\w`])@(?=[\w-])/g, '$1@​')
    .slice(0, max);
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
  return ['**RepoSpector**', ...f.tags.map((t) => clean(t)), status].join(' · ');
}

/** Suggested text that can be posted verbatim: unchanged by secret masking, no comment markers or fences. */
function safeReplacement(text: string): boolean {
  return redactSecrets(text) === text && !/<!--|-->|^\s*```/m.test(text) && text.length <= MAX_TEXT;
}

function suggestionBlock(fix: NonNullable<PostableFinding['fix']>, flavor: HostFlavor): string {
  const head = flavor === 'gitlab' ? `\`\`\`suggestion:-${fix.endLine - fix.startLine}+0` : '```suggestion';
  return `${head}\n${fix.replacement}${fix.replacement ? '\n' : ''}\`\`\``;
}

export function commentBody(f: PostableFinding, flavor?: HostFlavor): string {
  const suggestion = f.fix && flavor ? [suggestionBlock(f.fix, flavor), ''] : [];
  return [label(f), '', clean(f.claim), '', ...suggestion, ...(f.why ? [`<details><summary>Why</summary>\n\n${clean(f.why)}\n</details>`, ''] : []), markerFor(f.fingerprint)].join('\n');
}

const hunkOf = (hunks: PostableHunks, path: string, line: number): [number, number] | undefined => (hunks.get(path) ?? []).find(([a, b]) => line >= a && line <= b);

/** The fix as a suggestion when its whole range is in one hunk of the finding's file and its text can be posted verbatim. */
function postableFix(f: PostableFinding, hunks: PostableHunks): PostableFinding['fix'] {
  if (!f.fix || !safeReplacement(f.fix.replacement)) return undefined;
  const h = hunkOf(hunks, f.file, f.fix.startLine);
  return h && f.fix.endLine <= h[1] ? f.fix : undefined;
}

/** Last line of the finding in the diff, else its first, else any evidence line in the same file. */
function anchor(f: PostableFinding, hunks: PostableHunks): { path: string; line: number } | undefined {
  for (const line of [f.endLine, f.startLine]) if (inHunks(hunks, f.file, line)) return { path: f.file, line };
  for (const e of f.evidence ?? []) for (const line of [e.endLine, e.startLine]) if (inHunks(hunks, e.file, line)) return { path: e.file, line };
  return undefined;
}

export function buildPostPlan(findings: readonly PostableFinding[], hunks: PostableHunks, existing: ReadonlySet<string>, opts: PostOptions = {}): PostPlan {
  const inline: PlannedComment[] = [];
  const inSummary: PostPlan['inSummary'] = [];
  const alreadyPosted: string[] = [];
  const summaryLines: string[] = [];
  const overCap: string[] = [];
  const maxInline = opts.maxInline ?? DEFAULT_MAX_INLINE;
  const listed = (f: PostableFinding): string => `- \`${f.file}:${f.startLine}\` · ${[...f.tags.map((t) => clean(t)), clean(f.claim)].join(' · ')} ${markerFor(f.fingerprint)}`;
  for (const f of findings) {
    if (existing.has(f.fingerprint)) {
      alreadyPosted.push(f.id);
      continue;
    }
    const fix = opts.flavor ? postableFix(f, hunks) : undefined;
    const at = fix ? { path: f.file, line: fix.endLine, ...(fix.startLine < fix.endLine ? { startLine: fix.startLine } : {}) } : anchor(f, hunks);
    if (at && inline.length < maxInline) inline.push({ findingId: f.id, ...at, body: commentBody({ ...f, fix }, fix ? opts.flavor : undefined) });
    else if (at) {
      inSummary.push({ findingId: f.id, reason: `over the limit of ${maxInline} inline comments` });
      overCap.push(listed(f));
    } else {
      inSummary.push({ findingId: f.id, reason: 'no line of this finding is in the PR diff' });
      summaryLines.push(listed(f));
    }
  }
  const total = inline.length + inSummary.length;
  const summary = [
    ...(opts.walkthrough ? [clean(opts.walkthrough, 12_000), '', '---', ''] : []),
    `**RepoSpector review**: ${total} finding(s), ${inline.length} inline.${alreadyPosted.length ? ` ${alreadyPosted.length} already posted earlier.` : ''}`,
    ...(opts.extra?.length ? ['', ...opts.extra.map((t) => clean(t))] : []),
    ...(summaryLines.length ? ['', 'Outside the changed lines:', ...summaryLines] : []),
    ...(overCap.length ? ['', `More findings (inline comments are capped at ${maxInline}, most likely first):`, ...overCap] : []),
    '',
    '<sub>Drafted by RepoSpector and verified by a second agent. Review before publishing.</sub>',
  ].join('\n');
  return { inline, inSummary, alreadyPosted, summary };
}

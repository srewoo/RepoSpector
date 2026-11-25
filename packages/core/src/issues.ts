import { redactSecrets } from './untrusted.js';

/** An issue or ticket a pull request refers to. */
export type IssueRef =
  | { readonly kind: 'host'; readonly owner?: string | undefined; readonly repo?: string | undefined; readonly number: number }
  | { readonly kind: 'jira'; readonly key: string };

export interface LinkedIssue {
  /** Where it came from, e.g. "#12", "owner/repo#12", "ABC-123". */
  readonly ref: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string | undefined;
}

const MAX_REFS = 5;
export const MAX_ISSUE_BODY = 6000;

/**
 * Issue references in a pull request's title and description: `#12`, `owner/repo#12`, issue URLs on
 * the same host, and Jira-style keys (`ABC-123`). Code spans and fenced blocks are ignored.
 */
export function extractIssueRefs(text: string, host: string): IssueRef[] {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: IssueRef[] = [];
  const seen = new Set<string>();
  const add = (key: string, ref: IssueRef): void => {
    if (seen.has(key) || out.length >= MAX_REFS) return;
    // Values end up in API paths: no dot-only segments (path traversal), no empty ones.
    if (ref.kind === 'host' && [ref.owner, ref.repo].some((p) => p !== undefined && p.split('/').some((seg) => seg === '' || /^\.+$/.test(seg)))) return;
    seen.add(key);
    out.push(ref);
  };
  const hostRe = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // GitHub /issues/N, GitLab /-/issues/N (project path may have groups).
  for (const m of plain.matchAll(new RegExp(`https://${hostRe}/([\\w.-]+(?:/[\\w.-]+)*)/(?:-/)?issues/(\\d+)`, 'g'))) {
    const path = m[1] ?? '';
    const i = path.lastIndexOf('/');
    add(`${path}#${m[2]}`, { kind: 'host', owner: path.slice(0, i), repo: path.slice(i + 1), number: Number(m[2]) });
  }
  for (const m of plain.matchAll(/(?:^|[\s(,;:])([\w.-]+)\/([\w.-]+)#(\d+)\b/g)) add(`${m[1]}/${m[2]}#${m[3]}`, { kind: 'host', owner: m[1], repo: m[2], number: Number(m[3]) });
  for (const m of plain.matchAll(/(?:^|[\s(,;:])#(\d+)\b/g)) add(`#${m[1]}`, { kind: 'host', number: Number(m[1]) });
  for (const m of plain.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g)) add(m[1] ?? '', { kind: 'jira', key: m[1] ?? '' });
  return out;
}

export function issueRefLabel(r: IssueRef): string {
  if (r.kind === 'jira') return r.key;
  return r.owner && r.repo ? `${r.owner}/${r.repo}#${r.number}` : `#${r.number}`;
}

/** Linked issues as prompt text: titles and bodies, secrets masked, each body capped. */
export function issuesText(issues: readonly LinkedIssue[]): string {
  return issues.map((i) => `### ${i.ref}: ${i.title}\n${redactSecrets(i.body).slice(0, MAX_ISSUE_BODY)}`).join('\n\n');
}

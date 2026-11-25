import { parseToolOutput, type CiCheck, type CheckStatus, type Diagnostic, type DiagnosticLevel } from '../checks.js';
import { extractIssueRefs, issueRefLabel, type LinkedIssue } from '../issues.js';
import type { ReviewTarget } from '../review-url.js';
import { pages } from './json.js';
import type { ApiClient } from './types.js';

/**
 * Pull/merge request facts beyond the diff, through the same API client as the review (token only
 * in a header, same origin): description and base commit, files changed since an earlier commit,
 * CI results, linked issues, and the team's rules files. Every helper is read-only.
 */
type GitHubTarget = Extract<ReviewTarget, { kind: 'github' }>;
type GitLabTarget = Extract<ReviewTarget, { kind: 'gitlab' }>;

export interface PrDetails {
  readonly headSha: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
}

export const RULE_FILES = ['.RepoSpector/rules.md', 'REVIEW.md', 'CLAUDE.md', 'AGENTS.md'] as const;
const MAX_RULE_FILE = 20_000;
const MAX_ISSUES = 3;
const MAX_ANNOTATED_RUNS = 10;
const MAX_FAILED_JOBS = 5;
const TRACE_TAIL = 64_000;

const ghRepo = (t: GitHubTarget, owner = t.owner, repo = t.repo): string => `repos/${owner}/${repo}`;
const glProject = (t: GitLabTarget, project = t.project): string => `projects/${encodeURIComponent(project)}`;
const json = async <T>(api: ApiClient, path: string): Promise<T> => JSON.parse(await api.get(path)) as T;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function prDetails(t: ReviewTarget, api: ApiClient): Promise<PrDetails> {
  if (t.kind === 'github') {
    const pr = await json<{ head?: { sha?: unknown }; base?: { sha?: unknown }; title?: unknown; body?: unknown }>(api, `${ghRepo(t)}/pulls/${t.number}`);
    return { headSha: str(pr.head?.sha), baseSha: str(pr.base?.sha), title: str(pr.title), body: str(pr.body) };
  }
  const mr = await json<{ sha?: unknown; diff_refs?: { base_sha?: unknown }; title?: unknown; description?: unknown }>(api, `${glProject(t)}/merge_requests/${t.iid}`);
  return { headSha: str(mr.sha), baseSha: str(mr.diff_refs?.base_sha), title: str(mr.title), body: str(mr.description) };
}

/**
 * Files changed between an earlier reviewed head and the new head, or null when that cannot be
 * trusted (history rewritten by a force-push, too many files, or the host refused): review it all.
 */
export async function changedSince(t: ReviewTarget, api: ApiClient, from: string, to: string): Promise<string[] | null> {
  try {
    if (t.kind === 'github') {
      const c = await json<{ status?: string; files?: { filename?: string; previous_filename?: string }[] }>(api, `${ghRepo(t)}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`);
      if (c.status !== 'ahead' && c.status !== 'identical') return null;
      if (!c.files || c.files.length >= 300) return null;
      return c.files.flatMap((f) => [f.filename, f.previous_filename].filter((x): x is string => typeof x === 'string'));
    }
    const base = await json<{ id?: string }>(api, `${glProject(t)}/repository/merge_base?refs[]=${encodeURIComponent(from)}&refs[]=${encodeURIComponent(to)}`);
    if (base.id !== from) return null;
    const c = await json<{ diffs?: { new_path?: string; old_path?: string }[] }>(api, `${glProject(t)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!c.diffs || c.diffs.length >= 300) return null;
    return c.diffs.flatMap((d) => [d.new_path, d.old_path].filter((x): x is string => typeof x === 'string'));
  } catch {
    return null;
  }
}

const GH_FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
function ghStatus(status: unknown, conclusion: unknown): CheckStatus {
  if (status !== 'completed') return 'pending';
  if (GH_FAILED.has(str(conclusion))) return 'failed';
  return conclusion === 'skipped' ? 'skipped' : 'passed';
}
const ghLevel = (l: unknown): DiagnosticLevel => (l === 'failure' ? 'error' : l === 'warning' ? 'warning' : 'notice');

async function githubChecks(t: GitHubTarget, api: ApiClient, sha: string): Promise<CiCheck[]> {
  interface Run { id?: number; name?: string; status?: string; conclusion?: string; html_url?: string; output?: { title?: string; annotations_count?: number } }
  const runs = pages<{ check_runs?: Run[] }>(await api.get(`${ghRepo(t)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`, { paginate: true })).flatMap((p) => p.check_runs ?? []);
  const annotated = runs.filter((r) => (r.output?.annotations_count ?? 0) > 0 && typeof r.id === 'number').slice(0, MAX_ANNOTATED_RUNS);
  const notes = new Map<number, Diagnostic[]>();
  await Promise.all(
    annotated.map(async (r) => {
      const list = pages<{ path?: string; start_line?: number; annotation_level?: string; message?: string; title?: string }>(await api.get(`${ghRepo(t)}/check-runs/${r.id}/annotations?per_page=100`, { paginate: true }));
      notes.set(r.id as number, list.flatMap((a) => (a.path && a.start_line ? [{ source: str(r.name), file: a.path, line: a.start_line, level: ghLevel(a.annotation_level), message: [a.title, a.message].filter(Boolean).join(': ').slice(0, 500) }] : [])));
    }),
  );
  const out: CiCheck[] = runs.map((r) => ({ name: str(r.name) || 'check', status: ghStatus(r.status, r.conclusion), url: r.html_url, summary: r.output?.title, diagnostics: notes.get(r.id ?? -1) ?? [] }));
  try {
    const st = await json<{ statuses?: { context?: string; state?: string; target_url?: string; description?: string }[] }>(api, `${ghRepo(t)}/commits/${encodeURIComponent(sha)}/status`);
    for (const s of st.statuses ?? []) out.push({ name: str(s.context) || 'status', status: s.state === 'success' ? 'passed' : s.state === 'pending' ? 'pending' : 'failed', url: s.target_url, summary: s.description, diagnostics: [] });
  } catch {
    // Commit statuses are optional; check runs are enough.
  }
  return out;
}

function glStatus(s: unknown): CheckStatus {
  if (s === 'success') return 'passed';
  if (s === 'failed') return 'failed';
  if (s === 'skipped' || s === 'manual' || s === 'canceled') return 'skipped';
  return 'pending';
}

async function gitlabChecks(t: GitLabTarget, api: ApiClient, sha: string): Promise<CiCheck[]> {
  const pipes = pages<{ id?: number; sha?: string }>(await api.get(`${glProject(t)}/merge_requests/${t.iid}/pipelines`));
  const pipe = pipes.find((p) => p.sha === sha);
  if (!pipe?.id) return [];
  const jobs = pages<{ id?: number; name?: string; status?: string; web_url?: string; allow_failure?: boolean }>(await api.get(`${glProject(t)}/pipelines/${pipe.id}/jobs?per_page=100`, { paginate: true }));
  const failed = jobs.filter((j) => j.status === 'failed' && typeof j.id === 'number').slice(0, MAX_FAILED_JOBS);
  const diags = new Map<number, Diagnostic[]>();
  await Promise.all(
    failed.map(async (j) => {
      try {
        const trace = await api.get(`${glProject(t)}/jobs/${j.id}/trace`, { accept: 'raw' });
        // GitLab checks out into /builds/<namespace>/<project>; paths in logs are relative to it or under it.
        diags.set(j.id as number, parseToolOutput(str(j.name), trace.slice(-TRACE_TAIL), `/builds/${t.project}`));
      } catch {
        diags.set(j.id as number, []);
      }
    }),
  );
  return jobs.map((j) => ({ name: str(j.name) || 'job', status: glStatus(j.status), url: j.web_url, summary: j.allow_failure && j.status === 'failed' ? 'failed (allowed to fail)' : undefined, diagnostics: diags.get(j.id ?? -1) ?? [] }));
}

/** CI results for a commit. Throws when the host refuses (e.g. token lacks access); callers note it. */
export function ciChecks(t: ReviewTarget, api: ApiClient, sha: string): Promise<CiCheck[]> {
  return t.kind === 'github' ? githubChecks(t, api, sha) : gitlabChecks(t, api, sha);
}

export interface LinkedIssues {
  readonly issues: LinkedIssue[];
  /** Jira-style keys mentioned but not readable from the git host. */
  readonly ticketKeys: string[];
}

/** Issues the pull request links or closes on its own host (≤ 3), plus Jira-style keys it mentions. */
export async function linkedIssues(t: ReviewTarget, api: ApiClient, d: Pick<PrDetails, 'title' | 'body'>): Promise<LinkedIssues> {
  const refs = extractIssueRefs(`${d.title}\n${d.body}`, t.host);
  const ticketKeys = refs.flatMap((r) => (r.kind === 'jira' ? [r.key] : []));
  const issues: LinkedIssue[] = [];
  const add = (i: LinkedIssue): void => void (issues.length < MAX_ISSUES && !issues.some((x) => x.url === i.url) && issues.push(i));
  if (t.kind === 'gitlab') {
    try {
      for (const i of pages<{ iid?: number; title?: string; description?: string; web_url?: string }>(await api.get(`${glProject(t)}/merge_requests/${t.iid}/closes_issues`))) add({ ref: `#${i.iid}`, title: str(i.title), body: str(i.description), url: i.web_url });
    } catch {
      // Older GitLab or no access: fall back to references in the description.
    }
  }
  for (const r of refs) {
    if (r.kind !== 'host' || issues.length >= MAX_ISSUES) continue;
    try {
      if (t.kind === 'github') {
        const i = await json<{ title?: string; body?: string; html_url?: string; pull_request?: unknown }>(api, `${ghRepo(t, r.owner, r.repo)}/issues/${r.number}`);
        if (!i.pull_request) add({ ref: issueRefLabel(r), title: str(i.title), body: str(i.body), url: i.html_url });
      } else {
        const project = r.owner && r.repo ? `${r.owner}/${r.repo}` : t.project;
        const i = await json<{ title?: string; description?: string; web_url?: string }>(api, `${glProject(t, project)}/issues/${r.number}`);
        add({ ref: issueRefLabel(r), title: str(i.title), body: str(i.description), url: i.web_url });
      }
    } catch {
      // A reference that is not an issue, or not readable: skip it.
    }
  }
  return { issues, ticketKeys };
}

/** The team's rules files at a commit (the PR base, so a pull request cannot rewrite its own rules). */
export async function rulesAt(fileAt: (path: string, sha: string) => Promise<string>, sha: string): Promise<{ readonly text: string; readonly files: string[] }> {
  const found = await Promise.all(
    RULE_FILES.map(async (p) => {
      try {
        return { p, text: (await fileAt(p, sha)).slice(0, MAX_RULE_FILE) };
      } catch {
        return undefined;
      }
    }),
  );
  const ok = found.filter((f): f is { p: (typeof RULE_FILES)[number]; text: string } => !!f && f.text.trim().length > 0);
  return { text: ok.map((f) => `--- ${f.p} ---\n${f.text}`).join('\n\n'), files: ok.map((f) => f.p) };
}

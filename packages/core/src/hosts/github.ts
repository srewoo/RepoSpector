import { MARKER_RE, postableHunks, type PostableHunks, type PostPlan } from '../post.js';
import { pages } from './json.js';
import { HostError, type ApiClient, type PostResult, type ReviewHost, type TargetInfo } from './types.js';

type GitHubTarget = { readonly host: string; readonly owner: string; readonly repo: string; readonly number: number };

const markersIn = (text: string, into: Set<string>): void => {
  for (const m of text.matchAll(MARKER_RE)) if (m[1]) into.add(m[1]);
};

/** GitHub and GitHub Enterprise. Posts one PENDING review: visible only to its author until submitted. */
export class GitHubHost implements ReviewHost {
  private readonly pr: string;

  constructor(
    private readonly t: GitHubTarget,
    private readonly api: ApiClient,
  ) {
    this.pr = `repos/${t.owner}/${t.repo}/pulls/${t.number}`;
  }

  async info(): Promise<TargetInfo> {
    const pr = JSON.parse(await this.api.get(this.pr)) as { head?: { sha?: unknown }; title?: unknown };
    if (typeof pr.head?.sha !== 'string') throw new HostError('could not read the pull request head commit');
    return { headSha: pr.head.sha, ...(typeof pr.title === 'string' ? { title: pr.title } : {}) };
  }

  async hunks(): Promise<PostableHunks> {
    return postableHunks(await this.api.get(this.pr, { accept: 'diff' }));
  }

  /** The PR's unified diff (base merge-base to head). */
  diff(): Promise<string> {
    return this.api.get(this.pr, { accept: 'diff' });
  }

  /** One file's text at a commit (the repository-context pass reads only the files it needs). */
  fileAt(path: string, sha: string): Promise<string> {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    return this.api.get(`repos/${this.t.owner}/${this.t.repo}/contents/${enc}?ref=${encodeURIComponent(sha)}`, { accept: 'raw' });
  }

  async existingMarkers(): Promise<Set<string>> {
    const found = new Set<string>();
    for (const c of pages<{ body?: string }>(await this.api.get(`${this.pr}/comments?per_page=100`, { paginate: true }))) markersIn(c.body ?? '', found);
    for (const r of pages<{ body?: string; state?: string }>(await this.api.get(`${this.pr}/reviews?per_page=100`, { paginate: true }))) {
      // Only the viewer's own pending review is visible; GitHub allows one per user per pull request.
      if (r.state === 'PENDING') throw new HostError('you already have a pending review on this pull request; submit or discard it on GitHub, then post again');
      markersIn(r.body ?? '', found);
    }
    return found;
  }

  async post(plan: PostPlan, info: TargetInfo): Promise<PostResult> {
    // No `event` field: the review stays PENDING until the author submits it on GitHub.
    const body = { commit_id: info.headSha, body: plan.summary, comments: plan.inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: 'RIGHT' } : {}), body: c.body })) };
    const res = JSON.parse(await this.api.post(`${this.pr}/reviews`, body)) as { html_url?: string };
    return { posted: plan.inline.length, url: res.html_url ?? `https://${this.t.host}/${this.t.owner}/${this.t.repo}/pull/${this.t.number}`, failed: [] };
  }
}

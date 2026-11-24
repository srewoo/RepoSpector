import { MARKER_RE, postableHunks, type PostableHunks, type PostPlan } from '../post.js';
import { pages } from './json.js';
import { HostError, type ApiClient, type PostResult, type ReviewHost, type TargetInfo } from './types.js';

type GitLabTarget = { readonly host: string; readonly project: string; readonly iid: number };
interface DiffRefs {
  readonly base_sha: string;
  readonly start_sha: string;
  readonly head_sha: string;
}

/** GitLab (SaaS and self-managed). Posts draft notes, which only their author sees until published. */
export class GitLabHost implements ReviewHost {
  private readonly mr: string;
  private refs: DiffRefs | undefined;
  private readonly oldPath = new Map<string, string>();

  constructor(
    private readonly t: GitLabTarget,
    private readonly api: ApiClient,
  ) {
    this.mr = `projects/${encodeURIComponent(t.project)}/merge_requests/${t.iid}`;
  }

  async info(): Promise<TargetInfo> {
    const mr = JSON.parse(await this.api.get(this.mr)) as { sha?: unknown; diff_refs?: DiffRefs; title?: unknown };
    if (typeof mr.sha !== 'string' || !mr.diff_refs) throw new HostError('could not read the merge request head commit');
    this.refs = mr.diff_refs;
    return { headSha: mr.sha, ...(typeof mr.title === 'string' ? { title: mr.title } : {}) };
  }

  /** The MR's changes as one unified diff, rebuilt from GitLab's per-file diffs. */
  async diff(): Promise<string> {
    const files = pages<{ old_path: string; new_path: string; diff: string; new_file?: boolean; deleted_file?: boolean }>(await this.api.get(`${this.mr}/diffs?per_page=100`, { paginate: true }));
    let text = '';
    for (const f of files) {
      this.oldPath.set(f.new_path, f.old_path);
      const from = f.new_file ? '/dev/null' : `a/${f.old_path}`;
      const to = f.deleted_file ? '/dev/null' : `b/${f.new_path}`;
      text += `diff --git a/${f.old_path} b/${f.new_path}\n${f.new_file ? 'new file mode 100644\n' : ''}${f.deleted_file ? 'deleted file mode 100644\n' : ''}--- ${from}\n+++ ${to}\n${f.diff}`;
    }
    return text;
  }

  /** One file's text at a commit (the repository-context pass reads only the files it needs). */
  fileAt(path: string, sha: string): Promise<string> {
    return this.api.get(`projects/${encodeURIComponent(this.t.project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`, { accept: 'raw' });
  }

  async hunks(): Promise<PostableHunks> {
    return postableHunks(await this.diff());
  }

  async existingMarkers(): Promise<Set<string>> {
    const found = new Set<string>();
    const add = (text: string | undefined) => {
      for (const m of (text ?? '').matchAll(MARKER_RE)) if (m[1]) found.add(m[1]);
    };
    for (const d of pages<{ note?: string }>(await this.api.get(`${this.mr}/draft_notes`))) add(d.note);
    for (const n of pages<{ body?: string }>(await this.api.get(`${this.mr}/notes?per_page=100`, { paginate: true }))) add(n.body);
    return found;
  }

  async post(plan: PostPlan, info: TargetInfo): Promise<PostResult> {
    if (!this.refs) throw new HostError('call info() before post()');
    const failed: PostResult['failed'] = [];
    let posted = 0;
    for (const c of plan.inline) {
      const position = { position_type: 'text', ...this.refs, head_sha: info.headSha, old_path: this.oldPath.get(c.path) ?? c.path, new_path: c.path, new_line: c.line };
      try {
        await this.api.post(`${this.mr}/draft_notes`, { note: c.body, position });
        posted++;
      } catch (e) {
        failed.push({ findingId: c.findingId, error: (e as Error).message.slice(0, 200) });
      }
    }
    await this.api.post(`${this.mr}/draft_notes`, { note: plan.summary });
    return { posted, url: `https://${this.t.host}/${this.t.project}/-/merge_requests/${this.t.iid}`, failed };
  }
}

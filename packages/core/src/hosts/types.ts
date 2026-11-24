import type { PostableHunks, PostPlan } from '../post.js';

/**
 * Transport to a git host's REST API. Paths are relative to the API root (e.g. `repos/o/r/pulls/1`,
 * `projects/g%2Fp/merge_requests/1`). Implemented by the gh/glab CLIs (MCP) and by fetch (Chrome).
 */
export interface ApiClient {
  /** Raw response text. `paginate`: every page, in a form `pages()` flattens. `accept: 'diff'`: unified diff (GitHub). `accept: 'raw'`: a file's bytes as text. */
  get(path: string, opts?: { readonly accept?: 'diff' | 'raw'; readonly paginate?: boolean }): Promise<string>;
  /** JSON body; returns raw response text. */
  post(path: string, body: unknown): Promise<string>;
}

export interface TargetInfo {
  readonly headSha: string;
  /** Pull or merge request title; the review prompt includes it. */
  readonly title?: string;
}

export interface PostResult {
  /** Inline comments created. */
  readonly posted: number;
  readonly url: string;
  /** Inline comments the host refused; the summary still lists everything. */
  readonly failed: { readonly findingId: string; readonly error: string }[];
}

/** A PR or MR on a git host. Posts drafts only. */
export interface ReviewHost {
  info(): Promise<TargetInfo>;
  hunks(): Promise<PostableHunks>;
  /** Fingerprints already on the PR; throws if posting now would clash with an existing draft. */
  existingMarkers(): Promise<Set<string>>;
  post(plan: PostPlan, info: TargetInfo): Promise<PostResult>;
}

export class HostError extends Error {
  /** HTTP status when the host answered with an error; undefined for local or network failures. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

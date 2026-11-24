import { calledNames, definitionsText, parseUnifiedDiff, type ApiClient, type ReviewTarget } from '@repospector/core';
import { archivePlan, indexApiFields } from '../graph/archive.js';
import type { GraphJob, LocateReply } from '../graph/messages.js';
import { repoOf } from '../review/feedback.js';
import type { RepoContext } from './engine.js';

/** Files read for definitions are capped: one request each, and the text is capped anyway. */
export const MAX_CONTEXT_FILES = 30;
const CONCURRENCY = 4;

export interface RepoContextDeps {
  readonly target: ReviewTarget;
  readonly apiBase: string;
  readonly hostToken?: string | undefined;
  readonly api: ApiClient;
  /** One file's text at a commit, from the host API (only the files that hold definitions). */
  readonly fileAt: (path: string, sha: string) => Promise<string>;
  /** Builds or reuses the repository index at the commit and locates names (graph worker). */
  readonly locate: (job: Omit<GraphJob, 'maxDownloadBytes'>) => Promise<Extract<LocateReply, { type: 'located' }>>;
}

/**
 * Code, at the PR head, of what the diff's added lines call, construct or extend: names from the
 * diff, definitions from the whole-repository index, then only those files fetched. Returns empty
 * text when nothing the diff calls is defined elsewhere in the repository (no second pass is needed).
 */
export async function gatherRepoContext(input: { readonly diff: string; readonly headSha: string }, d: RepoContextDeps): Promise<RepoContext> {
  const names = calledNames(input.diff);
  if (names.length === 0) return { text: '', definitions: 0, indexedFiles: 0 };
  const addedLines = parseUnifiedDiff(input.diff).map((f) => [f.path, f.addedLines] as const);
  const plan = await archivePlan(d.target, d.apiBase, input.headSha, d.api);
  const hostApi = indexApiFields(d.target, d.apiBase, d.hostToken);
  const located = await d.locate({
    repo: repoOf(d.target),
    sha: input.headSha,
    findings: [],
    archiveUrl: plan.url,
    // The archive token only for private repositories (the download is redirected elsewhere).
    ...(plan.private && d.hostToken ? { token: d.hostToken } : {}),
    ...hostApi,
    locate: { names, addedLines },
  });
  const files = [...new Set(located.definitions.found.map((f) => f.file))].slice(0, MAX_CONTEXT_FILES);
  const contents = new Map<string, string>();
  const queue = [...files];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        // A file that cannot be read is skipped; the others still help.
        const text = await d.fileAt(f, input.headSha).catch(() => undefined);
        if (text !== undefined) contents.set(f, text);
      }
    }),
  );
  const { text, used } = definitionsText(located.definitions.found, (f) => contents.get(f));
  return { text, definitions: used.length, indexedFiles: located.files };
}

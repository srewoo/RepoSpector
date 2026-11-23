import * as z from 'zod/mini';

const httpsUrl = z.string().check(z.regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[^\s]*$/));

/**
 * Side panel → offscreen document: reader context for a finished run. Without `archiveUrl` only a
 * saved index may be used (no network). `token` (archive) is sent only for private repositories;
 * `apiToken` only to the GitHub API, to fetch just the files that changed.
 */
export const GraphStartSchema = z.strictObject({
  type: z.literal('graph:build'),
  runId: z.string().check(z.regex(/^[a-z0-9-]{8,64}$/)),
  repo: z.string().check(z.regex(/^[A-Za-z0-9.-]+(:\d{1,5})?\/[^\s@]+$/)),
  sha: z.string().check(z.regex(/^[0-9a-f]{40}$/)),
  archiveUrl: z.optional(httpsUrl),
  token: z.optional(z.string()),
  apiToken: z.optional(z.string()),
  githubRepoApi: z.optional(httpsUrl),
  findings: z.array(z.strictObject({ id: z.string(), file: z.string(), line: z.number() })).check(z.maxLength(500)),
});
export type GraphStart = z.infer<typeof GraphStartSchema>;

/** Offscreen document → graph worker. */
export type GraphJob = Omit<GraphStart, 'type' | 'runId'> & { readonly maxDownloadBytes: number };

export type GraphEvent =
  | { readonly type: 'progress'; readonly files: number; readonly downloadedMB: number }
  | { readonly type: 'done'; readonly source: 'saved' | 'changed-files' | 'download'; readonly files: number; readonly skipped: number; readonly reused: number; readonly ms: number; readonly context: Record<string, unknown> }
  | { readonly type: 'error'; readonly message: string; readonly noSavedIndex?: boolean };

export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

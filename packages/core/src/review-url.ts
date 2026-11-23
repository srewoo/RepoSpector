/** A pull request (GitHub, GitHub Enterprise) or merge request (GitLab SaaS or self-managed). */
export type ReviewTarget =
  | { readonly kind: 'github'; readonly host: string; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: 'gitlab'; readonly host: string; readonly project: string; readonly iid: number };

export class ReviewUrlError extends Error {}

const HOST = '([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\\d{1,5})?)';
const SEG = '(?!\\.{1,2}/)[A-Za-z0-9_.-]+';
const GITHUB = new RegExp(`^https://${HOST}/(${SEG})/(${SEG})/pull/(\\d{1,9})(?:/(?:files|commits|checks))?/?$`, 'i');
const GITLAB = new RegExp(`^https://${HOST}/((?:${SEG}/)+${SEG})/-/merge_requests/(\\d{1,9})(?:/(?:diffs|commits|pipelines))?/?$`, 'i');

/** A pull request or merge request URL; https only, no credentials, query or fragment ignored. */
export function parseReviewUrl(raw: string): ReviewTarget {
  const url = raw.trim().replace(/[?#].*$/, '');
  const gh = url.match(GITHUB);
  if (gh?.[1] && gh[2] && gh[3] && gh[4]) return { kind: 'github', host: gh[1].toLowerCase(), owner: gh[2], repo: gh[3], number: Number(gh[4]) };
  const gl = url.match(GITLAB);
  if (gl?.[1] && gl[2] && gl[3] && !gl[2].split('/').some((s) => s === '.' || s === '..')) return { kind: 'gitlab', host: gl[1].toLowerCase(), project: gl[2], iid: Number(gl[3]) };
  throw new ReviewUrlError('not a GitHub pull request or GitLab merge request URL (expected https://host/owner/repo/pull/N or https://host/group/project/-/merge_requests/N)');
}

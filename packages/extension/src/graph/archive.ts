import type { ApiClient, ReviewTarget } from '@repospector/core';

export interface ArchivePlan {
  /** The host API's archive endpoint for the reviewed commit (gzipped tar). */
  readonly url: string;
  /** Private repositories only: public archives are fetched with no token at all. */
  readonly private: boolean;
  /** GitHub reports repository size; GitLab does not without extra rights. */
  readonly approxMB: number | null;
  /** Origins the download touches, for the permission request. */
  readonly origins: readonly string[];
}

/** Host permission for GitHub's archive server, where api.github.com redirects tarball downloads. */
export const GITHUB_CODELOAD = 'https://codeload.github.com/*';

/**
 * Where to download the repository at `headSha`, and whether a token is needed. GitHub's tarball
 * endpoint redirects to codeload.github.com; Chrome drops Authorization on that cross-origin
 * redirect (checked in Chrome 153), and the token is only sent at all for private repositories.
 */
export async function archivePlan(target: ReviewTarget, apiBase: string, headSha: string, api: ApiClient): Promise<ArchivePlan> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('the review has no commit to index');
  if (target.kind === 'github') {
    const repo = JSON.parse(await api.get(`repos/${target.owner}/${target.repo}`)) as { private?: boolean; size?: number };
    const isDotCom = target.host === 'github.com';
    return {
      url: `${apiBase}/repos/${target.owner}/${target.repo}/tarball/${headSha}`,
      private: repo.private !== false,
      approxMB: typeof repo.size === 'number' ? Math.max(1, Math.round(repo.size / 1024)) : null,
      origins: isDotCom ? [GITHUB_CODELOAD] : [],
    };
  }
  const project = JSON.parse(await api.get(`projects/${encodeURIComponent(target.project)}`)) as { visibility?: string };
  return {
    url: `${apiBase}/projects/${encodeURIComponent(target.project)}/repository/archive.tar.gz?sha=${headSha}`,
    private: project.visibility !== 'public',
    approxMB: null,
    origins: [],
  };
}

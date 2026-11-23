import type { HostSetting } from './settings.js';

export interface TokenHelp {
  /** The host's page for creating a personal access token, with name and scopes filled in. */
  readonly url: string;
  /** What the token needs, in one or two sentences. */
  readonly text: string;
  /** Shown when posting is refused for lack of scope. */
  readonly missingScope: string;
}

/**
 * Token guidance per host. GitHub: a classic token with `repo` reads private pull requests and
 * creates pending reviews; a fine-grained one needs Pull requests: Read and write. GitLab: `api`
 * creates draft notes (`read_api` only reads).
 */
export function tokenHelp(host: HostSetting): TokenHelp {
  if (host.kind === 'github') {
    return {
      url: `${host.origin}/settings/tokens/new?description=RepoSpector&scopes=repo`,
      text: 'Use a classic token with the repo scope, or a fine-grained token with Pull requests: Read and write and Contents: Read on the repositories you review.',
      missingScope: 'It needs the repo scope (classic token) or Pull requests: Read and write (fine-grained token).',
    };
  }
  return {
    url: `${host.origin}/-/user_settings/personal_access_tokens?name=RepoSpector&scopes=api`,
    text: 'Use a personal access token with the api scope; read_api can read merge requests but cannot post draft notes.',
    missingScope: 'It needs the api scope.',
  };
}

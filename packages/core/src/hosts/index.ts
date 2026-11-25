import type { ReviewTarget } from '../review-url.js';
import { GitHubHost } from './github.js';
import { GitLabHost } from './gitlab.js';
import type { ApiClient } from './types.js';

export { GitHubHost } from './github.js';
export { GitLabHost } from './gitlab.js';
export { pages, parseJsonStream } from './json.js';
export { fetchClient, type FetchClientOptions } from './fetch-client.js';
export { HostError, type ApiClient, type PostResult, type ReviewHost, type TargetInfo } from './types.js';

export function hostFor(target: ReviewTarget, api: ApiClient): GitHubHost | GitLabHost {
  return target.kind === 'github' ? new GitHubHost(target, api) : new GitLabHost(target, api);
}
export * from './extras.js';

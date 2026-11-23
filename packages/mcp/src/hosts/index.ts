import { hostFor as coreHostFor, type GitHubHost, type GitLabHost, type ReviewTarget } from '@repospector/core';
import { cliClient } from './cli-client.js';
import type { CliRunner } from './types.js';

export { runCli } from './cli.js';
export { parseReviewUrl, ReviewUrlError } from './url.js';
export { HostError, type CliRunner, type PostResult, type ReviewHost, type ReviewTarget, type TargetInfo } from './types.js';

export function hostFor(target: ReviewTarget, run: CliRunner): GitHubHost | GitLabHost {
  return coreHostFor(target, cliClient(target, run));
}

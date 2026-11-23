/** Runs `gh` or `glab` with a fixed argument list; stdin carries a JSON request body. Returns stdout. */
export type CliRunner = (cmd: 'gh' | 'glab', args: readonly string[], stdin?: string) => Promise<string>;

export { HostError, type ApiClient, type PostResult, type ReviewHost, type TargetInfo, type ReviewTarget } from '@repospector/core';

import type { ApiClient, ReviewTarget } from '@repospector/core';
import type { CliRunner } from './types.js';

/** ApiClient over the user's own gh/glab login; the CLI handles auth, host and pagination. */
export function cliClient(target: ReviewTarget, run: CliRunner): ApiClient {
  const cmd = target.kind === 'github' ? 'gh' : 'glab';
  const base = ['api', '--hostname', target.host];
  return {
    get(path, opts = {}) {
      const accept = opts.accept === 'diff' && cmd === 'gh' ? ['-H', 'Accept: application/vnd.github.v3.diff'] : [];
      const paginate = opts.paginate ? (cmd === 'gh' ? ['--paginate', '--slurp'] : ['--paginate']) : [];
      return run(cmd, [...base, ...accept, ...paginate, path]);
    },
    post(path, body) {
      return run(cmd, [...base, '--method', 'POST', path, '--input', '-', '-H', 'Content-Type: application/json'], JSON.stringify(body));
    },
  };
}

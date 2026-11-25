import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { locateDefinitions, type ApiClient } from '@repospector/core';
import { gatherRepoContext } from '@repospector/extension/repo-context';
import type { RepoContext } from '@repospector/extension/engine';
import { GitRepo } from 'repospector-mcp/dist/git.js';
import { GraphService } from 'repospector-mcp/dist/graph/service.js';
import { prepareCheckout } from './checkout.js';
import type { MartianCase } from './martian.js';

const GRAPH_WAIT_MS = 600_000;

/** The archive plan only asks whether the repository is public; nothing else is called. */
const PUBLIC_REPO_API: ApiClient = {
  get: async () => JSON.stringify({ private: false, size: 1 }),
  post: async () => {
    throw new Error('not used');
  },
};

/**
 * The extension's repository-context step (its own gatherRepoContext: names from the diff, at most
 * 30 files, definitionsText) with the browser-only parts swapped for Node ones: the whole-repo
 * index comes from the MCP's tree-sitter graph of a PR-head checkout (same core extractor and
 * locateDefinitions) instead of the archive worker, and files are read from that checkout instead of
 * the host API. Martian repos are public, so the archive plan's repository lookup is answered locally.
 */
export function extensionRepoContext(c: MartianCase, cacheDir: string) {
  const [owner = '', repo = ''] = c.repo.split('/');
  return async (input: { readonly diff: string; readonly headSha: string }): Promise<RepoContext> => {
    const co = await prepareCheckout({ cacheDir, repo: c.repo, number: c.number });
    if (co.headSha !== input.headSha) throw new Error(`checkout head ${co.headSha} is not the PR head ${input.headSha}`);
    const git = await GitRepo.open(co.dir);
    const graph = await GraphService.open(git, resolve(cacheDir, 'graph'));
    if (!graph) throw new Error('the code graph needs node:sqlite (Node 22.13 or later)');
    try {
      return await gatherRepoContext(input, {
        target: { kind: 'github', host: 'github.com', owner, repo, number: c.number },
        apiBase: 'https://api.github.com',
        api: PUBLIC_REPO_API,
        fileAt: (path) => readFile(join(co.dir, path), 'utf8'),
        locate: async (job) => {
          const symbols = await graph.allSymbolsAt(input.headSha, GRAPH_WAIT_MS);
          if (!symbols) throw new Error('the code graph was not ready in time');
          const added = new Map((job.locate?.addedLines ?? []).map(([f, lines]) => [f, new Set(lines)] as const));
          return { type: 'located', reqId: 'eval', source: 'download', files: symbols.size, definitions: locateDefinitions(symbols, job.locate?.names ?? [], added) };
        },
      });
    } finally {
      graph.close();
    }
  };
}

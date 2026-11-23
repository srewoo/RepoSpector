#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { lookupSymbol } from './context.js';
import { GitRepo } from './git.js';
import { GraphService } from './graph/service.js';
import { RevisionSource } from './source.js';

/**
 * A server with one read-only tool, get_context, for one repo at one fixed commit. Used by the
 * eval to give a reviewer graph lookups without the review run.
 */
export async function createContextServer(opts: { root: string; head: string; cacheDir?: string }): Promise<McpServer> {
  if (!/^[0-9a-f]{40,64}$/.test(opts.head)) throw new Error('head must be a full commit id');
  const repo = await GitRepo.open(opts.root);
  const graph = await GraphService.open(repo, opts.cacheDir);
  // Build in the background so the server starts at once; lookups wait up to 2 minutes for it.
  void graph?.ensure(opts.head).catch(() => undefined);
  const source = new RevisionSource(repo, opts.head);
  const server = new McpServer({ name: 'repospector-context', version: '0.7.0' });
  server.registerTool(
    'get_context',
    {
      description:
        'Where an identifier (function, method, class, field) is defined and used in this repository at the pull request head: definitions with their body, calls with the calling function, and subclasses. Use it when the correctness of the diff depends on code outside it.',
      inputSchema: { symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,199}$/, 'an identifier such as getUser or get_user') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ symbol }) => {
      try {
        const ctx = await lookupSymbol(repo, opts.head, source, symbol, { graph, graphWaitMs: 120_000 });
        return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
      } catch (e) {
        console.error('[repospector-context] lookup failed:', e);
        return { isError: true, content: [{ type: 'text', text: 'lookup failed' }] };
      }
    },
  );
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, head: { type: 'string' }, cache: { type: 'string' } }, strict: true });
  try {
    const server = await createContextServer({ root: values.repo ?? process.cwd(), head: values.head ?? '', ...(values.cache ? { cacheDir: values.cache } : {}) });
    await server.connect(new StdioServerTransport());
  } catch (e) {
    console.error(`[repospector-context] failed to start: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

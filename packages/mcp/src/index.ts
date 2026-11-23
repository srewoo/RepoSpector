#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from './server.js';

// `repospector-mcp native …`: set up the Chrome extension's local mode (see native/install.ts).
if (process.argv[2] === 'native') {
  const { nativeCli } = await import('./native/install.js');
  try {
    process.exit(await nativeCli(process.argv.slice(3)));
  } catch (e) {
    console.error(`[repospector] ${(e as Error).message}`);
    process.exit(1);
  }
}

const { values } = parseArgs({
  options: { repo: { type: 'string' }, version: { type: 'boolean', default: false } },
  strict: true,
});

if (values.version) {
  console.log(VERSION);
} else {
  try {
    const server = await createServer({ root: values.repo ?? process.cwd() });
    await server.connect(new StdioServerTransport());
    console.error(`[repospector] MCP server ${VERSION} ready`);
  } catch (e) {
    console.error(`[repospector] failed to start: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

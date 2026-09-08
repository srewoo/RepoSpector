#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig } from './config.js';
import { createServer } from './server.js';

const config = parseConfig(process.argv.slice(2), process.env);
const server = createServer(config);

// stdout is the MCP transport. Anything written there that is not a protocol
// message corrupts the stream, so diagnostics MUST go to stderr — including
// any console.log inside a ported extension service.
console.log = (...args) => console.error(...args);

await server.connect(new StdioServerTransport());
console.error(`repospector-mcp ready — repo: ${config.repo}`);

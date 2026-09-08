import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools/registry.js';

/**
 * The version reported in the MCP handshake, read from package.json rather than
 * written here twice — hardcoded, it silently kept saying 0.1.0 after 0.1.1
 * shipped, so a client could not tell which build it was talking to.
 *
 * `../package.json` resolves correctly from BOTH entry points: this file is
 * src/server.js and the bundle is dist/index.js, each one level below the
 * package root. Never fatal — a server that will not start is worse than one
 * reporting an unknown version.
 */
function packageVersion() {
    try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    } catch {
        return '0.0.0-unknown';
    }
}

/**
 * Build the MCP server for one repository.
 *
 * Holds no state of its own beyond the config and the shared context object;
 * everything expensive (index, graph, model) is created lazily by the tools
 * that need it, because an MCP client spawns every configured server at launch
 * and one that indexes on boot is a bad citizen.
 */
export function createServer(config) {
    const server = new Server(
        { name: 'repospector', version: packageVersion() },
        { capabilities: { tools: {} } },
    );

    // Shared per-process context. Tools receive it and may populate lazily.
    const ctx = { config, indexer: null };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name, description, inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = TOOLS.find((t) => t.name === request.params.name);
        if (!tool) {
            // Structured, not thrown: the client is a model and can act on a
            // message that names what IS available.
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `Unknown tool "${request.params.name}". Available: ${TOOLS.map((t) => t.name).join(', ') || 'none'}.`,
                }],
            };
        }
        return tool.handler(request.params.arguments || {}, ctx);
    });

    return server;
}

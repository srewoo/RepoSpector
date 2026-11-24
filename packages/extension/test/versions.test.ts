import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTENSION_VERSION, MCP_VERSION } from '../src/versions.js';
import { VERSION } from '../../mcp/src/version.js';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;

describe('versions come from package.json (scripts/sync-versions.mjs)', () => {
  it('every copy matches; run `npm run build` after changing a package.json version', () => {
    const ext = json('../package.json').version;
    const mcp = json('../../mcp/package.json').version;
    expect(EXTENSION_VERSION).toBe(ext);
    expect(MCP_VERSION).toBe(mcp);
    expect(VERSION).toBe(mcp);
    expect((json('../../mcp/plugin/.mcp.json').mcpServers as { repospector: { args: string[] } }).repospector.args).toEqual(['-y', `repospector-mcp@${String(mcp)}`]);
    expect(json('../../mcp/plugin/.claude-plugin/plugin.json').version).toBe(mcp);
  });
});

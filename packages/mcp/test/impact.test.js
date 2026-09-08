import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPACT_OF_CHANGE_TOOL, REPO_OVERVIEW_TOOL } from '../src/tools/impact.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

// See search.test.js / index_repo.test.js: resolve from this file's own
// location, never process.cwd(), so both `node --test packages/mcp/test/`
// (repo root) and `npm test` (from inside packages/mcp) resolve the same file.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const TIMEOUT = 300000;
const ctx = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };

test('index the fixture once', { timeout: TIMEOUT }, async () => {
    assert.equal((await INDEX_REPO_TOOL.handler({ force: true }, ctx)).isError, undefined);
});

test('both tools declare their contract', () => {
    assert.equal(IMPACT_OF_CHANGE_TOOL.name, 'impact_of_change');
    assert.equal(REPO_OVERVIEW_TOOL.name, 'repo_overview');
    assert.equal(IMPACT_OF_CHANGE_TOOL.inputSchema.type, 'object');
});

test('repo_overview reports graph size and the parser mode', { timeout: TIMEOUT }, async () => {
    const r = await REPO_OVERVIEW_TOOL.handler({}, ctx);
    const text = r.content[0].text;
    assert.match(text, /nodes|symbols/i);
    // Parser mode must be visible so a degraded index is legible rather than
    // inferred later from poor answers.
    assert.match(text, /tree-sitter|regex-fallback/);
});

test('repo_overview works before any other tool, building the index if needed', { timeout: TIMEOUT }, async () => {
    const fresh = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };
    const r = await REPO_OVERVIEW_TOOL.handler({}, fresh);
    assert.equal(r.isError, undefined);
});

test('impact_of_change names what a change to a symbol reaches', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'hashPassword' }, ctx);
    const text = r.content[0].text;
    // hashPassword <- validatePassword <- login: the blast radius must mention
    // at least the direct dependent.
    assert.match(text, /validatePassword|auth\.js/, `expected a dependent, got:\n${text}`);
});

test('impact_of_change surfaces test coverage of the blast radius', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'validatePassword' }, ctx);
    assert.match(r.content[0].text, /test|covered|untested/i);
});

test('impact_of_change on an unknown symbol degrades with a hint', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'noSuchThing' }, ctx);
    assert.ok(r.content[0].text.length > 0);
    assert.match(r.content[0].text, /not found|no symbol|unknown/i);
});

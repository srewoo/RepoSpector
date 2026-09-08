import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';
import { getIndexer } from '../src/repo/indexer.js';

// Resolve from this file's own location, not process.cwd(): this test must
// pass identically under `node --test packages/mcp/test/` (repo root) and
// under `npm test` from inside packages/mcp.
//
// The fixture lives at packages/mcp/fixtures/mini-repo, a sibling of test/,
// not test/fixtures/mini-repo. Node's test runner treats EVERY file nested
// anywhere under a directory literally named `test` as a test file to
// execute, with no naming filter at all once that ancestor is matched — so a
// fixture placed under test/ gets its own .js files (and, worse, a
// Jest-style fixture file that legitimately needs to be named exactly
// `test/auth.test.js` for later TESTED_BY-edge work) swept into `node --test
// packages/mcp/test/` and run as real tests, which they are not. Moving the
// fixture tree out from under any `test`-named ancestor is the only fix that
// doesn't compromise that filename.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const TIMEOUT = 300000;

function ctx() {
    return { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };
}

test('the tool declares the wire contract the client sees', () => {
    assert.equal(INDEX_REPO_TOOL.name, 'index_repo');
    assert.ok(INDEX_REPO_TOOL.description.length > 0);
    assert.equal(INDEX_REPO_TOOL.inputSchema.type, 'object');
    // force and max_files are the two documented parameters.
    assert.ok('force' in INDEX_REPO_TOOL.inputSchema.properties);
    assert.ok('max_files' in INDEX_REPO_TOOL.inputSchema.properties);
});

test('indexes the fixture and reports what the build actually did', { timeout: TIMEOUT }, async () => {
    const result = await INDEX_REPO_TOOL.handler({ force: true }, ctx());
    const text = result.content[0].text;
    assert.equal(result.isError, undefined);
    assert.match(text, /files/i);
    // parser mode must be visible: a regex-fallback index that looks healthy is
    // how a caller comes to trust a weaker result.
    assert.match(text, /tree-sitter|regex-fallback/);
});

test('reports the repo it indexed, so a wrong --repo is obvious', { timeout: TIMEOUT }, async () => {
    const result = await INDEX_REPO_TOOL.handler({ force: true }, ctx());
    assert.match(result.content[0].text, /mini-repo/);
});

// The two tests below cover indexer.js's two "don't rebuild" branches, which
// the force:true tests above never touch:
//   - `if (ready && !force) return ready;`            — in-process cache hit
//   - `if (warm) { await loadGraph(...); return ... }` — warm snapshot load
// The warm branch is the one Ruling 1's schema-opening fix protects: it only
// works because openAllSchemas() runs before restore(), which runs before
// this check. Nothing else in the suite exercises it.

test('a second ensureIndexed call without force reuses the completed result, not a rebuild', { timeout: TIMEOUT }, async () => {
    // `ensureIndexed` is itself `async`, so every call — cache hit or not —
    // returns a distinct wrapper Promise object; that wrapper is not a usable
    // signal. What identifies a cache hit is the RESOLVED VALUE: on a hit,
    // `ensureIndexed` returns the stored `ready` promise as-is, so the value
    // it resolves to is the exact same object as the first call's. A rebuild
    // constructs a brand new result object, so object identity here is a
    // faithful proxy for "did `if (ready && !force) return ready;` fire".
    const context = ctx();
    const indexer = await getIndexer(context);

    const firstResult = await indexer.ensureIndexed({ force: true });
    assert.equal(firstResult.built, true);

    const secondResult = await indexer.ensureIndexed({}); // force omitted -> false
    assert.strictEqual(secondResult, firstResult,
        'a cache hit must resolve to the exact same result object as the first call, proving no rebuild ran');
});

test('a fresh indexer instance against an existing snapshot loads warm instead of rebuilding', { timeout: TIMEOUT }, async () => {
    // Build once so a real snapshot exists on disk at this repo's snapshotDir.
    const warmup = ctx();
    await INDEX_REPO_TOOL.handler({ force: true }, warmup);

    // A brand new indexer (ctx.indexer starts null, same repo path -> same
    // snapshotDir) must find that snapshot, restore into freshly-opened
    // schemas, see hasGraph() true, and take the warm branch rather than
    // re-reading and re-embedding every file.
    const freshCtx = ctx();
    const indexer = await getIndexer(freshCtx);
    const result = await indexer.ensureIndexed({}); // force omitted -> false

    assert.equal(result.built, false, 'a fresh indexer over an existing snapshot must report the warm outcome');
    assert.equal(result.repoId, indexer.repoId);

    // The tool-level view of the same outcome: no fresh build stats, so the
    // handler must say so explicitly rather than fabricating file counts.
    const toolResult = await INDEX_REPO_TOOL.handler({}, freshCtx);
    assert.match(toolResult.content[0].text, /already warm|loaded from the existing snapshot/i);
});

test('a repo that is not a git worktree returns a structured error, not a throw', async () => {
    const bad = { config: { repo: '/tmp', maxFiles: 10, maxToolTokens: 4096 }, indexer: null };
    const result = await INDEX_REPO_TOOL.handler({ force: true }, bad);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /git/i);
});

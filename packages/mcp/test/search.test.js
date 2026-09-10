import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL } from '../src/tools/search.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

// Resolve from this file's own location, not process.cwd(): must pass
// identically under `node --test packages/mcp/test/` (repo root) and under
// `npm test` from inside packages/mcp. Fixture lives at
// packages/mcp/fixtures/mini-repo, a sibling of test/ (see index_repo.test.js
// for why it is not under test/).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const TIMEOUT = 300000;

// One shared, indexed context: re-indexing per test would download and embed
// repeatedly for no added confidence.
const ctx = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };

test('index the fixture once', { timeout: TIMEOUT }, async () => {
    const r = await INDEX_REPO_TOOL.handler({ force: true }, ctx);
    assert.equal(r.isError, undefined);
});

test('each tool declares a name and an object schema', () => {
    for (const t of [SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL]) {
        assert.ok(t.name.length > 0);
        assert.equal(t.inputSchema.type, 'object');
        assert.ok(t.description.length > 0);
    }
    assert.equal(SEARCH_CODE_TOOL.name, 'search_code');
    assert.equal(GET_SYMBOL_TOOL.name, 'get_symbol');
    assert.equal(FIND_CALLERS_TOOL.name, 'find_callers');
});

// Regression: snippets came back headed `--- undefined`. RAGService feeds BM25
// `chunk.metadata`, which carried no filePath, so every fused hybrid hit had
// `filePath: undefined`. The model received code it could not cite or open, and
// `deduplicateResults` — which buckets by path — collapsed every chunk into one
// `'unknown'` bucket, turning maxChunksPerFile into a cap on the whole result
// set (asking for 10 returned 4). See src/utils/chunkId.js.
test('every snippet is headed by a real file path, never undefined', { timeout: TIMEOUT }, async () => {
    const r = await SEARCH_CODE_TOOL.handler({ query: 'validate a user password hash' }, ctx);
    const text = r.content[0].text;

    const headers = text.split('\n').filter(l => l.startsWith('--- '));
    assert.ok(headers.length > 0, 'expected at least one snippet header');
    for (const h of headers) {
        assert.doesNotMatch(h, /undefined|unknown/, `snippet header lost its path: ${h}`);
        // `--- path/to/file.js`, optionally `:start-end` now that line spans
        // landed, optionally ` (score 0.123)`. The span and the score are what
        // let a reader open the hit and judge it without a second call; the
        // path itself is what this test is actually guarding.
        assert.match(
            h,
            /^--- \S+\.\w+(:\d+(-\d+)?)?( \(score \d+\.\d+\))?$/,
            `not a file path: ${h}`,
        );
    }
    assert.ok(headers.some(h => h.includes('auth.js')), `expected auth.js among ${headers}`);
});

// The dedup cap is per file, not per result set: with paths restored, a query
// touching several files returns more than maxChunksPerFile chunks in total.
test('retrieval is not capped at maxChunksPerFile across all files', { timeout: TIMEOUT }, async () => {
    const { getIndexer } = await import('../src/repo/indexer.js');
    const ix = await getIndexer(ctx);
    const chunks = await ix.rag.retrieveContext(ix.repoId, 'session user password token', 10);

    const paths = chunks.map(c => c.filePath);
    for (const p of paths) assert.ok(p, 'chunk came back with no filePath');
    assert.ok(new Set(paths).size > 1, `expected several files, got ${JSON.stringify(paths)}`);
    assert.ok(chunks.length > 4, `expected >4 chunks across files, got ${chunks.length}`);
});

// The path also has to survive an index built BEFORE metadata carried it —
// every index already persisted in a user's browser. There the only remaining
// source is the chunk id (`repoId:filePath:chunkIndex`), which is what
// resolveChunkFilePath falls back to. Simulated by stripping the field from the
// loaded BM25 documents, since that is exactly what such an index looks like.
test('paths survive a legacy index whose metadata has no filePath', { timeout: TIMEOUT }, async () => {
    const { getIndexer } = await import('../src/repo/indexer.js');
    const ix = await getIndexer(ctx);

    // BM25 is loaded lazily on first search; force it before reaching in.
    await ix.rag.retrieveContext(ix.repoId, 'password', 5);
    const docs = ix.rag.hybridSearcher.bm25Index.documents;
    assert.ok(docs.size > 0, 'BM25 index did not load');

    // ctx is shared across this file's tests, so put back whatever we remove —
    // otherwise later tests silently run against a degraded index.
    const removed = new Map();
    for (const [id, doc] of docs) {
        if (doc.metadata && 'filePath' in doc.metadata) {
            removed.set(id, doc.metadata.filePath);
            delete doc.metadata.filePath;
        }
    }
    assert.ok(removed.size > 0, 'nothing to strip — test would be vacuous');

    try {
        const chunks = await ix.rag.retrieveContext(ix.repoId, 'validate a user password hash', 5);
        assert.ok(chunks.length > 0, 'no chunks returned');
        for (const c of chunks) {
            assert.ok(c.filePath, 'legacy chunk lost its path with no metadata fallback');
            assert.doesNotMatch(c.filePath, /undefined|unknown/);
        }
        assert.ok(chunks.some(c => c.filePath.includes('auth.js')), 'expected auth.js');
    } finally {
        for (const [id, filePath] of removed) {
            const doc = docs.get(id);
            if (doc?.metadata) doc.metadata.filePath = filePath;
        }
    }
});

test('search_code ranks the relevant file above the unrelated one', { timeout: TIMEOUT }, async () => {
    const r = await SEARCH_CODE_TOOL.handler({ query: 'validate a user password hash' }, ctx);
    const text = r.content[0].text;
    assert.equal(r.isError, undefined);
    assert.match(text, /auth\.js/, `expected auth.js in results:\n${text}`);
    // colours.js is deliberately unrelated; if it outranks auth.js, retrieval is broken.
    const authAt = text.indexOf('auth.js');
    const coloursAt = text.indexOf('colours.js');
    if (coloursAt >= 0) assert.ok(authAt < coloursAt, 'unrelated file outranked the relevant one');
});

test('search_code with no matches says so rather than returning blank', { timeout: TIMEOUT }, async () => {
    const r = await SEARCH_CODE_TOOL.handler({ query: 'zzzz-nonexistent-token-qqqq' }, ctx);
    assert.ok(r.content[0].text.length > 0);
});

test('get_symbol finds a real symbol and reports its file and line span', { timeout: TIMEOUT }, async () => {
    const r = await GET_SYMBOL_TOOL.handler({ name: 'validatePassword' }, ctx);
    const text = r.content[0].text;
    assert.match(text, /validatePassword/);
    assert.match(text, /auth\.js/);
    assert.match(text, /\d+/, 'expected a line number');
});

test('get_symbol on an unknown name offers near-misses so the caller can self-correct', { timeout: TIMEOUT }, async () => {
    const r = await GET_SYMBOL_TOOL.handler({ name: 'validatePasword' }, ctx); // typo
    const text = r.content[0].text;
    assert.match(text, /not found|no symbol/i);
    // The recovery path: a model that gets a bare "not found" retries blindly.
    assert.match(text, /validatePassword|did you mean|similar/i);
});

test('find_callers finds the caller of a function', { timeout: TIMEOUT }, async () => {
    const r = await FIND_CALLERS_TOOL.handler({ symbol: 'validatePassword' }, ctx);
    const text = r.content[0].text;
    // login() in session.js calls validatePassword.
    assert.match(text, /session\.js|login/, `expected the caller, got:\n${text}`);
});

test('find_callers on a symbol nothing calls says so plainly', { timeout: TIMEOUT }, async () => {
    const r = await FIND_CALLERS_TOOL.handler({ symbol: 'COLOURS' }, ctx);
    assert.ok(r.content[0].text.length > 0);
});

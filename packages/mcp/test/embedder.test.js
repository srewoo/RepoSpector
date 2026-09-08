import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeEmbedder, MODEL_NAME, EMBEDDING_DIMENSION } from '../src/adapters/embedder.js';

// Downloads ~90MB on the first run, then caches. Generous timeout by design.
const TIMEOUT = 300000;

test('produces 384-dimension vectors, matching the extension', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    assert.equal(e.getDimension(), 384);

    const [v] = await e.generateEmbeddings(['function alpha() { return 1; }']);
    assert.equal(v.length, 384);
    assert.ok(v.every((n) => Number.isFinite(n)), 'vector contains non-finite values');
});

test('is deterministic for the same input', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const [a] = await e.generateEmbeddings(['const x = 1;']);
    const [b] = await e.generateEmbeddings(['const x = 1;']);
    assert.deepEqual(a, b);
});

test('embeds a batch in input order', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const vs = await e.generateEmbeddings(['alpha', 'beta', 'gamma']);
    assert.equal(vs.length, 3);
    // Different inputs must not collapse to the same vector — that would mean
    // the batch is being embedded from one text.
    assert.notDeepEqual(vs[0], vs[1]);
});

test('similar code scores closer than unrelated code', { timeout: TIMEOUT }, async () => {
    // The property retrieval actually depends on. Dimensionality alone would
    // pass with a broken model.
    const e = createNodeEmbedder();
    await e.init();
    const [auth1, auth2, unrelated] = await e.generateEmbeddings([
        'function validateUserPassword(user, password) { return hash(password) === user.hash; }',
        'function checkCredentials(account, secret) { return digest(secret) === account.digest; }',
        'const colours = ["red", "green", "blue"];',
    ]);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.ok(dot(auth1, auth2) > dot(auth1, unrelated),
        'two auth functions should be closer than an auth function and a colour list');
});

test('generateEmbedding returns a single vector, not a batch', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const v = await e.generateEmbedding('hello');
    assert.equal(v.length, 384);
    assert.equal(typeof v[0], 'number');
});

// Ruling 2 (Task 5): getModelInfo() must carry both `model` and `name`, and
// `isReady`, so it lines up with OffscreenEmbeddingService's shape
// ({ name, dimension, isReady, provider }). RAGService.getProviderInfo()
// spreads whichever embedder is present; without this, a caller reading
// `.name` on this adapter silently got `undefined`. Guards against a future
// rename of `name` back to `model`-only going unnoticed.
test('getModelInfo() matches the extension embedder\'s shape', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();

    const before = e.getModelInfo();
    assert.equal(before.isReady, false, 'not ready before init()');

    await e.init();
    const info = e.getModelInfo();

    assert.equal(info.provider, 'local');
    assert.equal(info.model, MODEL_NAME);
    assert.equal(info.name, MODEL_NAME);
    assert.equal(info.dimension, EMBEDDING_DIMENSION);
    assert.equal(info.dimension, 384);
    assert.equal(info.isReady, true, 'ready after init()');
});

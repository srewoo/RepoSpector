/**
 * The bug these tests pin: the Repos tab gated indexing on `settings.apiKey`,
 * the CHAT provider's key. Indexing never calls the chat model — it embeds —
 * so a user on the bundled local embedder (the default, advertised in-product
 * as "No API key or network required") was shown "API Key Required" and had
 * the Re-index button disabled. Wrong in the other direction too: a user on
 * Gemini embeddings keeps their Google key in a different field, so an
 * apiKey-only check could wave through an index that cannot run.
 */
const {
    DEFAULT_EMBEDDING_PROVIDER,
    normalizeEmbeddingProvider,
    resolveEmbeddingKey,
    indexingKeyRequirement,
} = require('../../src/utils/embeddingKeyRequirement.js');

describe('normalizeEmbeddingProvider', () => {
    test('passes through the supported providers', () => {
        for (const p of ['local', 'openai', 'gemini']) {
            expect(normalizeEmbeddingProvider(p)).toBe(p);
        }
    });

    test('anything unrecognised falls back to local, matching the background', () => {
        for (const bad of [undefined, null, '', 'cohere', 'LOCAL', 42]) {
            expect(normalizeEmbeddingProvider(bad)).toBe(DEFAULT_EMBEDDING_PROVIDER);
        }
    });
});

describe('resolveEmbeddingKey', () => {
    test('local never needs a key', () => {
        expect(resolveEmbeddingKey('local', { apiKey: 'sk-x', googleApiKey: 'g' })).toBeNull();
    });

    test('openai embeddings use the shared apiKey', () => {
        expect(resolveEmbeddingKey('openai', { apiKey: 'sk-x' })).toBe('sk-x');
        expect(resolveEmbeddingKey('openai', {})).toBeNull();
    });

    test('gemini prefers its dedicated field', () => {
        expect(resolveEmbeddingKey('gemini', { googleApiKey: 'g-key', apiKey: 'sk-x' })).toBe('g-key');
    });

    test('gemini falls back to apiKey ONLY when the chat provider is also google', () => {
        expect(resolveEmbeddingKey('gemini', { provider: 'google', apiKey: 'g-shared' })).toBe('g-shared');
    });

    test('gemini never borrows another vendor key from apiKey', () => {
        // The failure this guards: handing an Anthropic key to Google.
        expect(resolveEmbeddingKey('gemini', { provider: 'anthropic', apiKey: 'sk-ant-x' })).toBeNull();
    });
});

describe('indexingKeyRequirement', () => {
    test('the default (local) needs no key — the reported bug', () => {
        const r = indexingKeyRequirement({ embeddingProvider: 'local' });
        expect(r.needsKey).toBe(false);
    });

    test('no embeddingProvider at all still means no key, since local is the default', () => {
        expect(indexingKeyRequirement({}).needsKey).toBe(false);
        expect(indexingKeyRequirement().needsKey).toBe(false);
    });

    test('a chat key present or absent is irrelevant to local indexing', () => {
        expect(indexingKeyRequirement({ embeddingProvider: 'local' }).needsKey).toBe(false);
        expect(indexingKeyRequirement({ embeddingProvider: 'local', apiKey: 'sk-x' }).needsKey).toBe(false);
    });

    test('openai embeddings without a key are blocked, and the message names the vendor', () => {
        const r = indexingKeyRequirement({ embeddingProvider: 'openai' });
        expect(r.needsKey).toBe(true);
        expect(r.title).toContain('OpenAI');
        expect(r.message).toMatch(/Local — Transformers\.js/);
    });

    test('openai embeddings with a key are allowed', () => {
        expect(indexingKeyRequirement({ embeddingProvider: 'openai', apiKey: 'sk-x' }).needsKey).toBe(false);
    });

    test('gemini embeddings blocked without a google key, allowed with one', () => {
        expect(indexingKeyRequirement({ embeddingProvider: 'gemini' }).needsKey).toBe(true);
        expect(indexingKeyRequirement({ embeddingProvider: 'gemini' }).title).toContain('Google');
        expect(indexingKeyRequirement({ embeddingProvider: 'gemini', googleApiKey: 'g' }).needsKey).toBe(false);
    });

    test('gemini embeddings are NOT unblocked by an unrelated vendor key', () => {
        const r = indexingKeyRequirement({
            embeddingProvider: 'gemini', provider: 'anthropic', apiKey: 'sk-ant-x',
        });
        expect(r.needsKey).toBe(true);
    });

    test('every blocking result offers a way out; every passing one stays silent', () => {
        const blocked = indexingKeyRequirement({ embeddingProvider: 'openai' });
        expect(blocked.title.length).toBeGreaterThan(0);
        expect(blocked.message.length).toBeGreaterThan(0);

        const fine = indexingKeyRequirement({ embeddingProvider: 'local' });
        expect(fine.title).toBe('');
        expect(fine.message).toBe('');
    });
});

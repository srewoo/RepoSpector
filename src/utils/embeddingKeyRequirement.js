/**
 * Does indexing need an API key, and which one?
 *
 * Indexing embeds code; it does not call the chat model. So gating it on
 * `settings.apiKey` — the chat provider's key — was wrong in both directions:
 * it blocked users on the bundled local embedder, who need no key at all, and
 * it would have waved through a user on Gemini embeddings whose Google key
 * lives in a different field.
 *
 * `resolveEmbeddingKey` deliberately mirrors the background's own resolution
 * (see `resolveEmbeddingKey` in src/background/index.js). Two copies of this
 * rule can disagree, and the failure mode is the worst kind: the UI says
 * "ready" and indexing then fails, or the UI blocks an index that would have
 * worked. If that function changes, change this one in the same commit.
 */

/** Embedding providers the extension supports. Anything else falls back to local. */
export const EMBEDDING_PROVIDERS = Object.freeze(['local', 'openai', 'gemini']);

/** The bundled Transformers.js embedder: no key, no network. */
export const DEFAULT_EMBEDDING_PROVIDER = 'local';

export function normalizeEmbeddingProvider(value) {
    return EMBEDDING_PROVIDERS.includes(value) ? value : DEFAULT_EMBEDDING_PROVIDER;
}

/**
 * The stored key this embedding provider would use, or null.
 *
 * Settings keeps one `apiKey` whose meaning follows the selected CHAT provider,
 * plus dedicated per-vendor fields. Embeddings are chosen independently, so the
 * two can disagree — prefer the dedicated field, and fall back to `apiKey` only
 * when the chat provider matches, never handing one vendor's key to another.
 */
export function resolveEmbeddingKey(provider, settings = {}) {
    if (provider === 'gemini') {
        return settings.googleApiKey
            || (settings.provider === 'google' ? settings.apiKey : null)
            || null;
    }
    if (provider === 'openai') {
        return settings.apiKey || null;
    }
    return null; // local needs none
}

/**
 * @param {object} settings The stored settings object.
 * @returns {{needsKey: boolean, provider: string, title: string, message: string}}
 *   `needsKey` false means indexing can run right now.
 */
export function indexingKeyRequirement(settings = {}) {
    const provider = normalizeEmbeddingProvider(settings.embeddingProvider);

    if (provider === DEFAULT_EMBEDDING_PROVIDER) {
        return {
            needsKey: false,
            provider,
            title: '',
            message: '',
        };
    }

    if (resolveEmbeddingKey(provider, settings)) {
        return { needsKey: false, provider, title: '', message: '' };
    }

    // Name the vendor and the escape hatch. "Set your API key in Settings" sent
    // people to paste a chat key that indexing never reads.
    const vendor = provider === 'gemini' ? 'Google' : 'OpenAI';
    return {
        needsKey: true,
        provider,
        title: `${vendor} API key required for embeddings`,
        message: `Your embedding provider is ${vendor}, which needs an API key to index. `
            + 'Add one in Settings, or switch Embedding Provider to '
            + '"Local — Transformers.js" to index with no key.',
    };
}

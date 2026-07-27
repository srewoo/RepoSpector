/**
 * ModelCatalogService — fetch the list of available models live from each provider,
 * so the Model dropdown never has to be hand-updated when new models ship.
 *
 * Runs in the background service worker (the extension's host_permissions cover
 * every provider host, so these calls aren't CORS-blocked). Given a provider + key
 * it returns normalized `{ id: "<provider>:<model>", name }` entries. Callers fall
 * back to a static list when there's no key or the fetch fails.
 *
 * Privacy: the key is used only to call that provider's own /models endpoint —
 * the same host the reviews already use. Nothing else sees it.
 */

// Substrings that mark a NON-chat model we should hide from the dropdown.
const NON_CHAT = /(embed|embedding|whisper|tts|audio|realtime|dall[- ]?e|image|moderation|rerank|vision-only|guard|clip|search)/i;

function normalize(provider, id, name) {
    return { id: `${provider}:${id}`, name: name || id };
}

async function fetchOpenAICompatible(baseUrl, apiKey, provider) {
    const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`${provider} /models ${res.status}`);
    const json = await res.json();
    const ids = (json.data || []).map(m => m.id).filter(Boolean);
    return ids
        .filter(id => !NON_CHAT.test(id))
        .sort((a, b) => b.localeCompare(a))
        .map(id => normalize(provider, id));
}

const FETCHERS = {
    async openai(apiKey) {
        // Keep only chat/reasoning families; hide embeddings/audio/image/etc.
        const all = await fetchOpenAICompatible('https://api.openai.com/v1', apiKey, 'openai');
        return all.filter(m => /(^openai:)(gpt|o\d|chatgpt)/i.test(m.id));
    },

    async anthropic(apiKey) {
        const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            }
        });
        if (!res.ok) throw new Error(`anthropic /models ${res.status}`);
        const json = await res.json();
        return (json.data || [])
            .map(m => normalize('anthropic', m.id, m.display_name || m.id))
            .sort((a, b) => b.id.localeCompare(a.id));
    },

    async google(apiKey) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
        if (!res.ok) throw new Error(`google /models ${res.status}`);
        const json = await res.json();
        return (json.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => {
                const id = String(m.name || '').replace(/^models\//, '');
                return normalize('google', id, m.displayName || id);
            })
            .filter(m => !NON_CHAT.test(m.id))
            .sort((a, b) => b.id.localeCompare(a.id));
    },

    async groq(apiKey) {
        return fetchOpenAICompatible('https://api.groq.com/openai/v1', apiKey, 'groq');
    },

    async mistral(apiKey) {
        return fetchOpenAICompatible('https://api.mistral.ai/v1', apiKey, 'mistral');
    },

    async local() {
        // Ollama — no key; enumerate locally pulled models.
        const res = await fetch('http://localhost:11434/api/tags');
        if (!res.ok) throw new Error(`ollama /api/tags ${res.status}`);
        const json = await res.json();
        return (json.models || [])
            .map(m => normalize('local', m.name, m.name))
            .sort((a, b) => a.id.localeCompare(b.id));
    }
};

export class ModelCatalogService {
    /**
     * @param {string} provider - 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral' | 'local'
     * @param {string} [apiKey] - required for all providers except 'local'
     * @returns {Promise<Array<{id:string, name:string}>>}
     */
    static async fetchModels(provider, apiKey) {
        const fetcher = FETCHERS[provider];
        if (!fetcher) throw new Error(`No model catalog for provider "${provider}"`);
        if (provider !== 'local' && (!apiKey || !apiKey.trim())) {
            throw new Error('API key required to list models');
        }
        const models = await fetcher(apiKey);
        if (!Array.isArray(models) || models.length === 0) throw new Error('No models returned');
        return models;
    }
}

export default ModelCatalogService;

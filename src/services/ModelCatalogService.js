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
const NON_CHAT = /(embed|embedding|whisper|tts|audio|realtime|dall[- ]?e|image|moderation|rerank|vision-only|guard|clip|search|transcribe|-instruct)/i;

/**
 * A dated snapshot of a model that also ships a stable alias: `o4-mini-2025-04-16`
 * beside `o4-mini`. Measured against a live OpenAI key, 29 of 80 returned ids were
 * snapshots — more than a third of the dropdown spent on duplicates of entries
 * already in it.
 */
const DATED_SNAPSHOT = /^(.*)-\d{4}-\d{2}-\d{2}$/;

/**
 * Version of a model id, for ordering "latest first".
 *
 * Handles both OpenAI families: `gpt-5.6-terra` → 5.6, `o4-mini` → 4,
 * `claude-sonnet-4` → 4, `gemini-2.0-flash` → 2.0. An id with no recognisable
 * version sorts last rather than being guessed at.
 */
function versionOf(bare) {
    // A fine-tune carries its base model inside the id
    // (`ft:gpt-3.5-turbo-0613:org::id`). Version it by that base, or every
    // fine-tune sorts as "no recognisable version" and lands at the bottom
    // regardless of how new the model it was trained from is.
    const ft = String(bare).match(/^ft:([^:]+):/i);
    if (ft) return versionOf(ft[1]);

    const m = String(bare).match(/(?:^|[a-z-])(?:gpt|o|claude[a-z-]*|gemini|llama|mistral|grok)?-?(\d+)(?:\.(\d+))?/i);
    if (!m) return { major: -1, minor: -1 };
    return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0 };
}

/**
 * Order a provider's models so the NEWEST is first, and drop snapshot duplicates.
 *
 * The previous ordering was `b.localeCompare(a)` — reverse alphabetical. Measured
 * against a live key that put `o4-mini-2025-04-16` at the top and the newest
 * flagship (`gpt-5.6-*`) at position **15**, below fourteen older reasoning
 * models. A dropdown whose whole purpose is "pick the latest model" made the
 * latest model the hardest one to find.
 *
 * Ties break toward the SHORTER id, which is how a stable alias (`gpt-5.6`) wins
 * over a variant (`gpt-5.6-terra`) at the same version.
 */
export function rankModels(models) {
    const ids = new Set(models.map(m => m.id));

    const deduped = models.filter(m => {
        const snap = DATED_SNAPSHOT.exec(m.id);
        // Keep a snapshot only when its stable alias is absent from this list.
        return !snap || !ids.has(snap[1]);
    });

    // Strip ONLY the provider prefix. `split(':').pop()` took the LAST segment,
    // which for a fine-tune (`openai:ft:gpt-3.5-turbo-0613:org::88pNyu07`) is the
    // opaque suffix `88pNyu07` — and `versionOf` read the leading digits of that
    // as "version 88", sorting every fine-tune above the newest flagship and
    // handing one of them the ⭐. A colon is legal inside a model id; only the
    // first one delimits the provider.
    const bareOf = (id) => String(id).replace(/^[^:]+:/, '');

    const sorted = [...deduped].sort((a, b) => {
        const bareA = bareOf(a.id);
        const bareB = bareOf(b.id);
        const va = versionOf(bareA);
        const vb = versionOf(bareB);
        if (vb.major !== va.major) return vb.major - va.major;
        if (vb.minor !== va.minor) return vb.minor - va.minor;
        if (bareA.length !== bareB.length) return bareA.length - bareB.length;
        return bareA.localeCompare(bareB);
    });

    // Mark the top entry so the UI can star it. Only one: "recommended" means
    // something only while it is scarce.
    return sorted.map((m, i) => (i === 0 ? { ...m, recommended: true } : m));
}

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
    return ids.filter(id => !NON_CHAT.test(id)).map(id => normalize(provider, id));
}

const FETCHERS = {
    async openai(apiKey) {
        // Keep only chat/reasoning families; hide embeddings/audio/image/etc.
        //
        // `ft:` is explicitly included. A fine-tune is named
        // `ft:gpt-3.5-turbo-0613:<org>::<id>`, so a pattern anchored on the family
        // prefix dropped every one — an organisation's OWN fine-tuned models were
        // the one category of model it could be certain it wanted, and they were
        // the only category invisible in the dropdown. Measured against a real
        // key: 15 of 22 models this filter rejected were that org's fine-tunes.
        //
        // `chat-latest` and `computer-use-preview` are chat models whose ids
        // simply do not start with a family name; both are usable and both were
        // being hidden by an implementation detail of the regex.
        const all = await fetchOpenAICompatible('https://api.openai.com/v1', apiKey, 'openai');
        return all.filter(m => /(^openai:)(ft:|gpt|o\d|chatgpt|chat-|computer-use)/i.test(m.id));
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
        // Rank LAST, after every provider-specific filter has run. Ranking inside
        // the fetcher marked a model `recommended` that a later family filter then
        // removed, so the star silently vanished from the dropdown.
        return rankModels(models);
    }
}

export default ModelCatalogService;

import { BedrockClient } from './BedrockClient.js';
import {
    BEDROCK_FALLBACK_MODELS,
    OPENROUTER_FALLBACK_MODELS,
    NVIDIA_FALLBACK_MODELS,
} from '../utils/constants.js';

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

// Substrings that mark a model of the wrong MODALITY — it cannot answer a chat
// request at all, whichever provider is serving it.
const NON_CHAT_MODALITY = /(embed|embedding|whisper|tts|audio|realtime|dall[- ]?e|image|moderation|rerank|vision-only|guard|clip|search|transcribe)/i;

// Substrings that mark a NON-chat model we should hide from the dropdown.
//
// `-instruct` belongs here only for the first-party providers, where it marks a
// legacy completions variant of a model already in the list. It is NOT a
// modality: on OpenRouter and NVIDIA NIM it is how the chat models are NAMED
// (`meta/llama-3.3-70b-instruct`), so applying it there emptied most of the
// catalogue. Those providers filter on NON_CHAT_MODALITY alone.
const NON_CHAT = new RegExp(`${NON_CHAT_MODALITY.source}|-instruct`, 'i');

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

async function fetchOpenAICompatible(baseUrl, apiKey, provider, { reject = NON_CHAT } = {}) {
    const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`${provider} /models ${res.status}`);
    const json = await res.json();
    const ids = (json.data || []).map(m => m.id).filter(Boolean);
    return ids.filter(id => !reject.test(id)).map(id => normalize(provider, id));
}

/**
 * A gateway listing is one API call away from being the only usable list, and
 * one network blip away from being empty. Both gateways therefore behave like
 * Bedrock: fall back to the static catalogue and SAY SO, rather than leaving the
 * dropdown blank or letting a stale list pass for a live read.
 */
function staticFallback(provider, models, reason) {
    const fallback = models.map(m => normalize(provider, m.id, m.name));
    fallback.isFallback = true;
    fallback.fallbackReason = reason;
    return fallback;
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

    /**
     * OpenRouter — hundreds of models across every vendor behind one key.
     *
     * Its /models carries a human `name` ("Anthropic: Claude Sonnet 4.5"), which
     * is the only thing that makes a list this long navigable, so it is used
     * instead of the raw id. Output modality is checked from `architecture` when
     * present: the catalogue includes image-generation models whose ids give no
     * hint of it.
     */
    async openrouter(apiKey) {
        try {
            const res = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { Authorization: `Bearer ${apiKey}`, 'X-Title': 'RepoSpector' }
            });
            if (!res.ok) throw new Error(`openrouter /models ${res.status}`);
            const json = await res.json();
            const models = (json.data || [])
                .filter(m => m && m.id && !NON_CHAT_MODALITY.test(m.id))
                .filter(m => {
                    const out = m.architecture?.output_modalities;
                    // Absent field means an older response shape, not an image
                    // model — do not drop a model over a field that is missing.
                    return !Array.isArray(out) || out.includes('text');
                })
                .map(m => normalize('openrouter', m.id, m.name || m.id));
            if (!models.length) throw new Error('openrouter returned no chat models');
            return models;
        } catch (e) {
            console.warn('OpenRouter live model listing failed, using static list:', e.message);
            return staticFallback('openrouter', OPENROUTER_FALLBACK_MODELS, e.message);
        }
    },

    /**
     * NVIDIA NIM (build.nvidia.com). OpenAI-compatible listing; ids are
     * vendor-pathed and overwhelmingly `-instruct`-suffixed, hence the
     * modality-only filter.
     */
    async nvidia(apiKey) {
        try {
            const models = await fetchOpenAICompatible(
                'https://integrate.api.nvidia.com/v1', apiKey, 'nvidia',
                { reject: NON_CHAT_MODALITY },
            );
            if (!models.length) throw new Error('nvidia returned no chat models');
            return models;
        } catch (e) {
            console.warn('NVIDIA NIM live model listing failed, using static list:', e.message);
            return staticFallback('nvidia', NVIDIA_FALLBACK_MODELS, e.message);
        }
    },

    /**
     * Bedrock takes a credentials object, not a key string — the one provider
     * whose listing is itself a signed API call. Both listings are attempted
     * inside the client; a total failure falls back to the static catalogue so
     * the dropdown is never empty just because the account lacks
     * `bedrock:ListFoundationModels`.
     */
    async bedrock(creds) {
        const client = new BedrockClient(creds);
        try {
            const models = await client.listModels();
            return models
                .filter(m => !NON_CHAT.test(m.id))
                .map(m => normalize('bedrock', m.id, m.name));
        } catch (e) {
            console.warn('Bedrock live model listing failed, using static list:', e.message);
            // Tell the caller this list is the fallback, so the UI can say so
            // instead of implying it read the account.
            return staticFallback('bedrock', BEDROCK_FALLBACK_MODELS, e.message);
        }
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
     * @param {string} provider - 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral'
     *        | 'openrouter' | 'nvidia' | 'bedrock' | 'local'
     * @param {string} [apiKey] - required for all providers except 'local'
     * @returns {Promise<Array<{id:string, name:string}>>}
     */
    static async fetchModels(provider, credential) {
        const fetcher = FETCHERS[provider];
        if (!fetcher) throw new Error(`No model catalog for provider "${provider}"`);

        if (provider === 'bedrock') {
            // `credential` is { accessKeyId, secretAccessKey, sessionToken, region }.
            if (!credential?.accessKeyId || !credential?.secretAccessKey) {
                throw new Error('AWS Access Key ID and Secret Access Key required to list models');
            }
        } else if (provider !== 'local' && (typeof credential !== 'string' || !credential.trim())) {
            throw new Error('API key required to list models');
        }

        const models = await fetcher(credential);
        if (!Array.isArray(models) || models.length === 0) throw new Error('No models returned');
        // Rank LAST, after every provider-specific filter has run. Ranking inside
        // the fetcher marked a model `recommended` that a later family filter then
        // removed, so the star silently vanished from the dropdown.
        const ranked = rankModels(models);
        // Carry the fallback marker across ranking so the UI can distinguish a
        // list read from the account from the hardcoded one.
        if (models.isFallback) {
            ranked.isFallback = true;
            ranked.fallbackReason = models.fallbackReason;
        }
        return ranked;
    }
}

export default ModelCatalogService;

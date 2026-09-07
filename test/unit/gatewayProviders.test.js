/**
 * OpenRouter + NVIDIA NIM — the two OpenAI-compatible gateways.
 *
 * What is actually at risk with a gateway is not the transport (it is the
 * OpenAI wire format, already proven elsewhere) but the two places a gateway
 * differs from a first-party provider:
 *
 *   1. Model ids are vendor-pathed and may carry a variant suffix
 *      (`deepseek/deepseek-r1:free`), so only the FIRST colon may be read as
 *      the provider delimiter.
 *   2. Their catalogues are almost entirely `-instruct`-named, which the
 *      first-party non-chat filter rejects — applying it here empties the
 *      dropdown.
 */

const { LLMService } = require('../../src/services/LLMService.js');
const { ModelCatalogService } = require('../../src/services/ModelCatalogService.js');
const { resolveModel } = require('../../src/utils/modelResolver.js');
const {
    LLM_PROVIDERS,
    API_ENDPOINTS,
    OPENROUTER_FALLBACK_MODELS,
    NVIDIA_FALLBACK_MODELS,
} = require('../../src/utils/constants.js');
const { describeAuthError } = require('../../src/utils/authErrors.js');

function captureChat() {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return {
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 12, completion_tokens: 3 },
            }),
        };
    });
    return calls;
}

function mockJson(payload, ok = true, status = 200) {
    global.fetch = jest.fn().mockResolvedValue({
        ok, status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    });
}

afterEach(() => { delete global.fetch; });

describe('provider registration', () => {
    it('registers both gateways with chat and models endpoints', () => {
        expect(LLM_PROVIDERS.OPENROUTER).toBe('openrouter');
        expect(LLM_PROVIDERS.NVIDIA).toBe('nvidia');
        expect(API_ENDPOINTS.openrouter.chat).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(API_ENDPOINTS.nvidia.chat).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    });

    it('names the credential in auth failures instead of "your AI provider"', () => {
        expect(describeAuthError(new Error('401'), { provider: 'openrouter' }))
            .toMatch(/OpenRouter API key/);
        expect(describeAuthError(new Error('401'), { provider: 'nvidia' }))
            .toMatch(/NVIDIA NIM API key/);
    });

    it('ships fallback ids that are vendor-pathed wire names, not aliases', () => {
        // There is no MODELS alias table for these providers: whatever follows
        // the first colon is sent verbatim. A bare `claude-sonnet-4.5` here
        // would 404 at review time.
        for (const m of [...OPENROUTER_FALLBACK_MODELS, ...NVIDIA_FALLBACK_MODELS]) {
            expect(m.id).toMatch(/^[^:]+\/[^:]+/);
        }
    });
});

describe('model identifier round-tripping', () => {
    it('keeps a vendor path intact', () => {
        expect(resolveModel('openrouter:anthropic/claude-sonnet-4.5')).toEqual({
            modelIdentifier: 'openrouter:anthropic/claude-sonnet-4.5',
            provider: 'openrouter',
            modelId: 'anthropic/claude-sonnet-4.5',
        });
    });

    it('keeps a variant suffix, splitting only on the first colon', () => {
        // OpenRouter's free/paid variants are `:free`, `:nitro`, `:floor`.
        // Splitting on the last colon would send the model as `free`.
        expect(resolveModel('openrouter:deepseek/deepseek-r1:free').modelId)
            .toBe('deepseek/deepseek-r1:free');
    });

    it('resolves an NVIDIA id', () => {
        expect(resolveModel('nvidia:meta/llama-3.3-70b-instruct')).toMatchObject({
            provider: 'nvidia',
            modelId: 'meta/llama-3.3-70b-instruct',
        });
    });
});

describe('chat transport', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });

    it('OpenRouter: posts the OpenAI format to openrouter.ai with the bearer key', async () => {
        const calls = captureChat();
        const res = await svc.callLLM(
            { model: 'openrouter:anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] },
            'sk-or-v1-test',
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(calls[0].init.headers.Authorization).toBe('Bearer sk-or-v1-test');
        // Attribution header, so the user's OpenRouter activity page can name
        // the app that spent the money.
        expect(calls[0].init.headers['X-Title']).toBe('RepoSpector');
        // The vendor path is the wire model name — the provider prefix is gone.
        expect(calls[0].body.model).toBe('anthropic/claude-sonnet-4.5');
        expect(res.content).toBe('ok');
        expect(res.usage).toMatchObject({ input: 12, output: 3 });
    });

    it('NVIDIA: posts to integrate.api.nvidia.com', async () => {
        const calls = captureChat();
        await svc.callLLM(
            { model: 'nvidia:meta/llama-3.3-70b-instruct', messages: [{ role: 'user', content: 'hi' }] },
            'nvapi-test',
        );

        expect(calls[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
        expect(calls[0].init.headers.Authorization).toBe('Bearer nvapi-test');
        expect(calls[0].body.model).toBe('meta/llama-3.3-70b-instruct');
    });

    it('surfaces the provider name and body when a call fails', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false, status: 402,
            text: async () => 'insufficient credits',
        });
        const svc2 = new LLMService();
        svc2.maxRetries = 0;
        await expect(svc2.callLLM(
            { model: 'openrouter:openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
            'k',
        )).rejects.toThrow(/OpenRouter API error \(402\): insufficient credits/);
    });

    it('does not claim tool-loop support: it varies per model behind the gateway', () => {
        expect(LLMService.supportsTools('openrouter')).toBe(false);
        expect(LLMService.supportsTools('nvidia')).toBe(false);
    });
});

describe('model listing', () => {
    it('OpenRouter: prefers the human name and drops non-text output', async () => {
        mockJson({ data: [
            { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
            { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B Instruct' },
            { id: 'openai/dall-e-3', name: 'OpenAI: DALL-E 3' },
            { id: 'some/imagegen', name: 'Image gen', architecture: { output_modalities: ['image'] } },
        ] });

        const models = await ModelCatalogService.fetchModels('openrouter', 'sk-or-v1');
        const ids = models.map(m => m.id);

        expect(ids).toContain('openrouter:anthropic/claude-sonnet-4.5');
        // `-instruct` is how a gateway names its chat models — it must survive.
        expect(ids).toContain('openrouter:meta-llama/llama-3.3-70b-instruct');
        expect(ids).not.toContain('openrouter:openai/dall-e-3');
        expect(ids).not.toContain('openrouter:some/imagegen');
        expect(models.find(m => m.id === 'openrouter:anthropic/claude-sonnet-4.5').name)
            .toBe('Anthropic: Claude Sonnet 4.5');
        expect(models.isFallback).toBeFalsy();
    });

    it('OpenRouter: keeps a model whose response omits the architecture field', async () => {
        // Dropping a model over a field the API did not send would silently
        // shrink the catalogue the day the response shape changes.
        mockJson({ data: [{ id: 'x-ai/grok-4', name: 'Grok 4' }] });
        const ids = (await ModelCatalogService.fetchModels('openrouter', 'k')).map(m => m.id);
        expect(ids).toEqual(['openrouter:x-ai/grok-4']);
    });

    it('NVIDIA: keeps -instruct ids and drops embedding/rerank models', async () => {
        mockJson({ data: [
            { id: 'nvidia/llama-3.3-nemotron-super-49b-v1' },
            { id: 'meta/llama-3.3-70b-instruct' },
            { id: 'nvidia/nv-embedqa-e5-v5' },
            { id: 'nvidia/rerank-qa-mistral-4b' },
        ] });

        const ids = (await ModelCatalogService.fetchModels('nvidia', 'nvapi-x')).map(m => m.id);
        expect(ids).toContain('nvidia:meta/llama-3.3-70b-instruct');
        expect(ids).toContain('nvidia:nvidia/llama-3.3-nemotron-super-49b-v1');
        expect(ids).not.toContain('nvidia:nvidia/nv-embedqa-e5-v5');
        expect(ids).not.toContain('nvidia:nvidia/rerank-qa-mistral-4b');
    });

    it('first-party providers still drop -instruct variants', async () => {
        // The filter split must not have loosened the providers it was written
        // for: on OpenAI, `-instruct` marks a legacy completions variant.
        mockJson({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-3.5-turbo-instruct' }] });
        const ids = (await ModelCatalogService.fetchModels('openai', 'sk-t')).map(m => m.id);
        expect(ids).toContain('openai:gpt-4.1');
        expect(ids).not.toContain('openai:gpt-3.5-turbo-instruct');
    });

    it('falls back to the static list, marked as such, when listing fails', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false, status: 500, json: async () => ({}), text: async () => 'boom',
        });

        for (const [provider, fallback] of [
            ['openrouter', OPENROUTER_FALLBACK_MODELS],
            ['nvidia', NVIDIA_FALLBACK_MODELS],
        ]) {
            const models = await ModelCatalogService.fetchModels(provider, 'k');
            expect(models).toHaveLength(fallback.length);
            // The caption in Settings says "loaded live" or "built-in list" on
            // the strength of this flag; a stale list that claims to be live is
            // worse than one that admits it.
            expect(models.isFallback).toBe(true);
            expect(models.fallbackReason).toMatch(/500/);
            // Order is rankModels' business, not the fallback list's — assert
            // membership, so a ranking change does not fail this test.
            expect(models.map(m => m.id).sort())
                .toEqual(fallback.map(m => `${provider}:${m.id}`).sort());
        }
    });

    it('still requires a key before listing', async () => {
        await expect(ModelCatalogService.fetchModels('openrouter', '')).rejects.toThrow(/key required/i);
        await expect(ModelCatalogService.fetchModels('nvidia', '')).rejects.toThrow(/key required/i);
    });
});

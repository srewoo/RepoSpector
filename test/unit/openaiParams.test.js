/**
 * OpenAI reasoning-model parameter dialect.
 *
 * These models reject `max_tokens` and the sampling controls with a flat 400.
 * The two things worth pinning are that the translation happens, and that it
 * does NOT happen for every other model — a rewrite that touched `gpt-4.1`
 * would change the request bodies of essentially every current user.
 */

const {
    usesNewerParams,
    normalizeOpenAIRequest,
} = require('../../src/utils/openaiParams.js');
const { REASONING_PATTERNS } = require('../../src/utils/modelCapabilities.js');
const { LLMService } = require('../../src/services/LLMService.js');

describe('usesNewerParams', () => {
    it.each([
        'openai:o1-mini', 'openai:o3', 'openai:o3-mini', 'openai:o4-mini',
        'openai:gpt-5', 'openai:gpt-5-mini', 'o4-mini',
    ])('recognises %s', (model) => {
        expect(usesNewerParams(model)).toBe(true);
    });

    it.each([
        'openai:gpt-4.1', 'openai:gpt-4.1-mini', 'openai:gpt-4o',
        'openai:ft:gpt-3.5-turbo-0613:org::abc', '', null,
    ])('leaves %s on the legacy dialect', (model) => {
        expect(usesNewerParams(model)).toBe(false);
    });

    it('strips only the provider prefix', () => {
        // A gateway id carries its own colon; reading the last one would make
        // `openrouter:openai/o4-mini` look like the model `o4-mini`.
        expect(usesNewerParams('openrouter:openai/o4-mini')).toBe(false);
    });
});

describe('normalizeOpenAIRequest', () => {
    it('renames max_tokens and drops the refused sampling controls', () => {
        const { request, renamed, dropped } = normalizeOpenAIRequest({
            model: 'openai:o4-mini',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.1,
            top_p: 0.9,
            frequency_penalty: 0.2,
            max_tokens: 4096,
        });

        expect(request.max_completion_tokens).toBe(4096);
        expect(request).not.toHaveProperty('max_tokens');
        expect(request).not.toHaveProperty('temperature');
        expect(request).not.toHaveProperty('top_p');
        expect(request).not.toHaveProperty('frequency_penalty');
        // Everything else is carried through untouched.
        expect(request.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(renamed).toEqual(['max_tokens→max_completion_tokens']);
        expect(dropped).toEqual(expect.arrayContaining(['temperature', 'top_p', 'frequency_penalty']));
    });

    it('returns the very same object for a legacy model', () => {
        // Identity, not equality: no rebuild, no key reordering, so existing
        // request bodies are byte-identical to what they were.
        const input = { model: 'openai:gpt-4.1', temperature: 0.3, max_tokens: 4096 };
        const { request, renamed, dropped } = normalizeOpenAIRequest(input);
        expect(request).toBe(input);
        expect(renamed).toEqual([]);
        expect(dropped).toEqual([]);
    });

    it('does not mutate the caller\'s object', () => {
        const input = { model: 'openai:gpt-5', temperature: 0.1, max_tokens: 100 };
        normalizeOpenAIRequest(input);
        expect(input).toEqual({ model: 'openai:gpt-5', temperature: 0.1, max_tokens: 100 });
    });

    it('keeps an explicit max_completion_tokens over a stray max_tokens', () => {
        // A caller that already knows the newer name meant it.
        const { request, dropped } = normalizeOpenAIRequest({
            model: 'openai:o3', max_completion_tokens: 50, max_tokens: 4096,
        });
        expect(request.max_completion_tokens).toBe(50);
        expect(request).not.toHaveProperty('max_tokens');
        expect(dropped).toContain('max_tokens');
    });

    it('adds nothing when the caller sent no cap', () => {
        const { request } = normalizeOpenAIRequest({ model: 'openai:o4-mini', messages: [] });
        expect(request).not.toHaveProperty('max_completion_tokens');
        expect(request).not.toHaveProperty('max_tokens');
    });

    it('carries a max_tokens of 0 through rather than treating it as absent', () => {
        const { request } = normalizeOpenAIRequest({ model: 'openai:o4-mini', max_tokens: 0 });
        expect(request.max_completion_tokens).toBe(0);
    });
});

describe('the two OpenAI model lists agree', () => {
    it('every OpenAI reasoning family also uses the newer parameter names', () => {
        // These lists answer different questions and are intentionally
        // separate, but they are identical in fact. If you add a family to
        // REASONING_PATTERNS.openai, decide explicitly whether its endpoint
        // takes `max_tokens` or `max_completion_tokens` — a missed entry here
        // 400s every request to that model.
        const samples = {
            '/^o\\d/': 'o4-mini',
            '/^gpt-5/': 'gpt-5',
        };
        for (const pattern of REASONING_PATTERNS.openai) {
            const sample = samples[String(pattern)];
            expect(sample).toBeDefined();
            expect(usesNewerParams(sample)).toBe(true);
        }
    });
});

describe('the OpenAI transport applies it', () => {
    afterEach(() => { delete global.fetch; });

    function capture() {
        const calls = [];
        global.fetch = jest.fn(async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
            };
        });
        return calls;
    }

    it('sends max_completion_tokens and no temperature for a reasoning model', async () => {
        const calls = capture();
        await new LLMService().callLLM(
            {
                model: 'openai:o4-mini',
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.1,
                max_tokens: 4096,
            },
            'sk-t',
        );

        expect(calls[0].body.max_completion_tokens).toBe(4096);
        expect(calls[0].body).not.toHaveProperty('max_tokens');
        expect(calls[0].body).not.toHaveProperty('temperature');
        // The wire model name is still the resolved id, not the prefixed one.
        expect(calls[0].body.model).toBe('o4-mini');
    });

    it('leaves a non-reasoning OpenAI request exactly as it was', async () => {
        const calls = capture();
        await new LLMService().callLLM(
            {
                model: 'openai:gpt-4.1-mini',
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.3,
                max_tokens: 4096,
            },
            'sk-t',
        );

        expect(calls[0].body.max_tokens).toBe(4096);
        expect(calls[0].body.temperature).toBe(0.3);
        expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
    });

    it('does not reshape other providers, which accept max_tokens as-is', async () => {
        const calls = capture();
        await new LLMService().callLLM(
            {
                model: 'openrouter:openai/o4-mini',
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.1,
                max_tokens: 100,
            },
            'sk-or-v1-t',
        );

        // OpenRouter normalises for the upstream model itself; second-guessing
        // it here would strip a parameter the gateway supports.
        expect(calls[0].body.max_tokens).toBe(100);
        expect(calls[0].body.temperature).toBe(0.1);
    });
});

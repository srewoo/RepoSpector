/**
 * The session lifecycle is the load-bearing part: sessions carry conversation
 * state and a hard quota, while every caller here passes a full message array
 * and expects statelessness. A leaked session would bleed one review into the
 * next. destroy() is therefore asserted on the success path AND on the throw
 * path, because the throw path is the one that gets forgotten.
 */
const { LLMService } = require('../../src/services/LLMService.js');
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');

/** A fake `LanguageModel` global. `captured` records what the session saw. */
function installFakeLanguageModel({ availability = 'available', reply = 'ok', chunks = null, throwOn = null } = {}) {
    const captured = { created: null, prompts: [], destroyed: 0 };
    globalThis.LanguageModel = {
        availability: async () => availability,
        params: async () => ({ defaultTemperature: 1, maxTemperature: 2, defaultTopK: 3, maxTopK: 8 }),
        create: async (opts) => {
            captured.created = opts;
            return {
                inputQuota: 6144,
                measureInputUsage: async (text) => Math.ceil(text.length / 4),
                prompt: async (text) => {
                    captured.prompts.push(text);
                    if (throwOn === 'prompt') throw new Error('prompt exploded');
                    return reply;
                },
                promptStreaming: (text) => {
                    captured.prompts.push(text);
                    const parts = chunks || [reply];
                    let i = 0;
                    return {
                        getReader: () => ({
                            read: async () => (i < parts.length
                                ? { done: false, value: parts[i++] }
                                : { done: true, value: undefined }),
                        }),
                    };
                },
                destroy: () => { captured.destroyed += 1; },
            };
        },
    };
    return captured;
}

describe('LLMService.callChromeAI', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });
    afterEach(() => { delete globalThis.LanguageModel; });

    const req = { model: 'chrome-ai:nano', messages: [{ role: 'user', content: 'hi' }] };

    test('returns the model reply', async () => {
        installFakeLanguageModel({ reply: 'a summary' });
        await expect(svc.callChromeAI(req)).resolves.toBe('a summary');
    });

    test('passes the system message as initialPrompts, not in the prompt', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI({
            model: 'chrome-ai:nano',
            messages: [
                { role: 'system', content: 'You review code.' },
                { role: 'user', content: 'check this' },
            ],
        });
        expect(JSON.stringify(captured.created.initialPrompts)).toContain('You review code.');
        expect(captured.prompts[0]).not.toContain('You review code.');
        expect(captured.prompts[0]).toContain('check this');
    });

    // Chrome warns when a request omits an output language, and only accepts
    // de/en/es/fr/ja. Asserted at the create() boundary because that is the
    // only place the declaration can be made.
    test('declares an English output language on every create()', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI(req);
        expect(captured.created.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
    });

    test('declares the output language even when there is no system message', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI({ model: 'chrome-ai:nano', messages: [{ role: 'user', content: 'hi' }] });
        expect(captured.created.expectedOutputs).toBeTruthy();
        expect(captured.created.initialPrompts).toBeUndefined();
    });

    test('destroys the session on success', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI(req);
        expect(captured.destroyed).toBe(1);
    });

    test('destroys the session when the prompt throws', async () => {
        const captured = installFakeLanguageModel({ throwOn: 'prompt' });
        await expect(svc.callChromeAI(req)).rejects.toThrow('prompt exploded');
        expect(captured.destroyed).toBe(1);
    });

    test('refuses an over-quota prompt with ChromeAIQuotaError', async () => {
        installFakeLanguageModel();
        const huge = { model: 'chrome-ai:nano', messages: [{ role: 'user', content: 'x'.repeat(200000) }], };
        await expect(svc.callChromeAI(huge, { task: 'pr_review' }))
            .rejects.toMatchObject({ name: 'ChromeAIQuotaError', task: 'pr_review' });
    });

    test('fails clearly when the global is absent', async () => {
        await expect(svc.callChromeAI(req)).rejects.toThrow(/Chrome 138|not available/i);
    });

    test('fails clearly when the model still needs downloading', async () => {
        installFakeLanguageModel({ availability: 'downloadable' });
        await expect(svc.callChromeAI(req)).rejects.toThrow(/download/i);
    });

    test('counts the system prompt toward the quota check, not just the user prompt', async () => {
        installFakeLanguageModel();
        // Small user prompt, but a system prompt alone large enough to blow the
        // 6144-token fake quota. If the precise (measureInputUsage) path only
        // measures `prompt`, this slips through unnoticed.
        const huge = {
            model: 'chrome-ai:nano',
            messages: [
                { role: 'system', content: 'y'.repeat(30000) },
                { role: 'user', content: 'check this' },
            ],
        };
        await expect(svc.callChromeAI(huge, { task: 'pr_review' }))
            .rejects.toMatchObject({ name: 'ChromeAIQuotaError', task: 'pr_review' });
    });

    test('streams every chunk through sendChunk and ends with the last-chunk flag', async () => {
        installFakeLanguageModel({ chunks: ['Hel', 'lo', '!'] });
        const seen = [];
        svc.sendChunk = (tabId, chunk, full, requestId, isLast) => seen.push({ chunk, full, isLast });

        const result = await svc.callChromeAI(req, { streaming: true, tabId: 7, requestId: 'r1' });

        expect(result).toBe('Hello!');
        expect(seen.map((s) => s.chunk)).toEqual(['Hel', 'lo', '!', '']);
        expect(seen.at(-1).isLast).toBe(true);
        expect(seen.at(-1).full).toBe('Hello!');
        expect(seen.slice(0, -1).every((s) => s.isLast === false)).toBe(true);
    });
});

describe('LLMService._dispatchToProvider', () => {
    test('routes chrome-ai to callChromeAI without an apiKey argument', () => {
        const svc = new LLMService();
        const calls = [];
        svc.callChromeAI = (...args) => { calls.push(args); return Promise.resolve('x'); };
        svc._dispatchToProvider(LLM_PROVIDERS.CHROME_AI, { model: 'm' }, 'A-KEY', { task: 't' });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toEqual({ model: 'm' });
        expect(calls[0][1]).toEqual({ task: 't' });
        expect(calls[0]).toHaveLength(2);
    });
});

/**
 * Nano's four availability states matter because two of them are transitional:
 * first use triggers a multi-gigabyte download, and a provider that renders
 * "downloading" as an endless spinner is worse than one that is honestly
 * absent. The quota assertion exists so an over-budget prompt is refused with a
 * typed error rather than silently truncated by the API.
 */
const {
    CHROME_AI_AVAILABILITY,
    probeChromeAI,
    shapeChromeAIPrompt,
    estimateTokens,
    ChromeAIQuotaError,
    assertFitsQuota,
} = require('../../src/utils/chromeAI.js');

describe('probeChromeAI', () => {
    afterEach(() => { delete globalThis.LanguageModel; });

    test('reports unavailable when the global is absent', async () => {
        const { state, reason } = await probeChromeAI();
        expect(state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
        expect(reason).toMatch(/Chrome 138/);
    });

    test('passes through each state the API reports', async () => {
        for (const state of ['available', 'downloadable', 'downloading', 'unavailable']) {
            globalThis.LanguageModel = { availability: async () => state };
            expect((await probeChromeAI()).state).toBe(state);
        }
    });

    test('a throwing availability() is unavailable, not a crash', async () => {
        globalThis.LanguageModel = { availability: async () => { throw new Error('boom'); } };
        const { state, reason } = await probeChromeAI();
        expect(state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
        expect(reason).toMatch(/boom/);
    });

    test('an unrecognised state string is treated as unavailable', async () => {
        globalThis.LanguageModel = { availability: async () => 'something-new' };
        expect((await probeChromeAI()).state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
    });
});

describe('shapeChromeAIPrompt', () => {
    test('system messages become the system prompt', () => {
        const { system, prompt } = shapeChromeAIPrompt([
            { role: 'system', content: 'You review code.' },
            { role: 'user', content: 'Summarise this.' },
        ]);
        expect(system).toBe('You review code.');
        expect(prompt).toContain('Summarise this.');
        expect(prompt).not.toContain('You review code.');
    });

    test('multiple system messages are joined, matching Anthropic handling', () => {
        const { system } = shapeChromeAIPrompt([
            { role: 'system', content: 'A' },
            { role: 'system', content: 'B' },
            { role: 'user', content: 'go' },
        ]);
        expect(system).toBe('A\n\nB');
    });

    test('prior turns are labelled so the model can follow the exchange', () => {
        const { prompt } = shapeChromeAIPrompt([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'second' },
        ]);
        expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('reply'));
        expect(prompt.indexOf('reply')).toBeLessThan(prompt.indexOf('second'));
    });

    test('no system message yields an empty system string, never undefined', () => {
        expect(shapeChromeAIPrompt([{ role: 'user', content: 'x' }]).system).toBe('');
    });

    test('an empty message list does not throw', () => {
        expect(shapeChromeAIPrompt([])).toEqual({ system: '', prompt: '' });
    });
});

describe('estimateTokens', () => {
    test('scales with length and never returns zero for real text', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('abcd')).toBeGreaterThan(0);
        expect(estimateTokens('a'.repeat(4000)))
            .toBeGreaterThan(estimateTokens('a'.repeat(400)));
    });
});

describe('assertFitsQuota', () => {
    test('is silent when the prompt fits', () => {
        expect(() => assertFitsQuota({ promptTokens: 100, quota: 6144, task: 'file_summary' }))
            .not.toThrow();
    });

    test('throws a typed error naming the task and the overage', () => {
        let caught;
        try {
            assertFitsQuota({ promptTokens: 9000, quota: 6144, task: 'pr_review' });
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(ChromeAIQuotaError);
        expect(caught.name).toBe('ChromeAIQuotaError');
        expect(caught.task).toBe('pr_review');
        expect(caught.promptTokens).toBe(9000);
        expect(caught.quota).toBe(6144);
        expect(caught.message).toMatch(/pr_review/);
    });

    test('an unknown quota does not block the call', () => {
        expect(() => assertFitsQuota({ promptTokens: 9e9, quota: null, task: 't' }))
            .not.toThrow();
    });
});

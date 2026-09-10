describe('context windows for current models', () => {
    const { TokenManager } = require('../../src/utils/tokenManager.js');
    const tm = new TokenManager();

    it.each([
        ['openai:gpt-5', 400000],
        ['openai:gpt-5-mini', 400000],
        ['openai:o3', 200000],
        ['openai:gpt-4o', 128000],
        ['anthropic:claude-sonnet-4-5-20250929', 200000],
        ['anthropic:claude-opus-4-1', 200000],
        ['google:gemini-2.5-pro', 1000000],
        ['groq:llama-3.3-70b-versatile', 128000],
    ])('%s → %i', (id, expected) => {
        expect(tm.getModelLimit(id)).toBe(expected);
    });

    it('an unknown model gets a modern default, not 8000', () => {
        expect(tm.getModelLimit('openrouter:some/new-model')).toBe(128000);
    });

    it('output limit resolves by family too', () => {
        expect(tm.getOutputLimit('anthropic:claude-sonnet-4-5')).toBe(8192);
        expect(tm.getOutputLimit('openai:gpt-5')).toBe(16384);
    });
});

/**
 * getModelLimit is handed TWO different name shapes: catalogue keys
 * (`groq:mixtral-8x7b`, from MultiPassReviewEngine/MultiFinderService) and
 * RESOLVED provider model ids (from getModelId(settings.model), used all over
 * src/background/index.js). The resolved ids matched none of the hand-written
 * tables and fell through to the 128000 default, so getAvailableTokens would
 * happily build a ~118k-token prompt for a 32k model — a provider 400 rather
 * than the old harmless over-chunking.
 */
describe('resolved provider model ids get their real context window', () => {
    const { TokenManager } = require('../../src/utils/tokenManager.js');
    const tm = new TokenManager();

    it.each([
        ['mixtral-8x7b-32768', 32768],
        ['mistral-small-latest', 32000],
        ['qwen2.5-coder:32b', 32000],
        // Whatever tag the user actually pulled resolves to the same window.
        ['local:qwen2.5-coder', 32000],
        ['local:qwen2.5-coder:7b', 32000],
        ['codestral-latest', 32000],
    ])('%s → %i', (id, expected) => {
        expect(tm.getModelLimit(id)).toBe(expected);
    });

    it('the catalogue is authoritative, so codestral no longer claims 256000', () => {
        const { MODELS } = require('../../src/utils/constants.js');
        expect(tm.getModelLimit('codestral-latest'))
            .toBe(MODELS['mistral:codestral'].contextWindow);
    });

    it('an available-token budget for a 32k model stays under its window', () => {
        expect(tm.getAvailableTokens('mixtral-8x7b-32768')).toBeLessThan(32768);
    });

    it('catalogue keys still resolve, and family prefixes still win first', () => {
        expect(tm.getModelLimit('groq:mixtral-8x7b')).toBe(32768);
        expect(tm.getModelLimit('groq:llama-3.3-70b-versatile')).toBe(128000);
    });
});

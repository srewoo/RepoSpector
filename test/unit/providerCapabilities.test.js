/**
 * Nano is the only provider with a real context ceiling, and the ceiling is
 * read from a live session rather than hardcoded — Chrome can change it. These
 * tests pin that the declared number is only ever a pre-session fallback, and
 * that adding the provider changed nothing for the other eleven.
 */
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');
const {
    getCapabilities,
    providerNeedsKey,
    effectiveContextTokens,
    CHROME_AI_FALLBACK_CONTEXT_TOKENS,
} = require('../../src/utils/providerCapabilities.js');

describe('providerCapabilities', () => {
    test('declares an entry for every provider', () => {
        for (const id of Object.values(LLM_PROVIDERS)) {
            expect(getCapabilities(id)).toBeTruthy();
        }
    });

    test('an unknown provider is unconstrained and key-requiring', () => {
        const caps = getCapabilities('not-a-provider');
        expect(caps.maxContextTokens).toBeNull();
        expect(caps.needsKey).toBe(true);
    });

    test('only chrome-ai declares a context ceiling', () => {
        for (const id of Object.values(LLM_PROVIDERS)) {
            const expected = id === LLM_PROVIDERS.CHROME_AI
                ? CHROME_AI_FALLBACK_CONTEXT_TOKENS
                : null;
            expect(getCapabilities(id).maxContextTokens).toBe(expected);
        }
    });

    test('ollama and chrome-ai need no key; the rest do', () => {
        expect(providerNeedsKey(LLM_PROVIDERS.LOCAL)).toBe(false);
        expect(providerNeedsKey(LLM_PROVIDERS.CHROME_AI)).toBe(false);
        for (const id of [
            LLM_PROVIDERS.OPENAI, LLM_PROVIDERS.ANTHROPIC, LLM_PROVIDERS.GOOGLE,
            LLM_PROVIDERS.GROQ, LLM_PROVIDERS.MISTRAL, LLM_PROVIDERS.OPENROUTER,
            LLM_PROVIDERS.NVIDIA, LLM_PROVIDERS.COHERE, LLM_PROVIDERS.PERPLEXITY,
            LLM_PROVIDERS.HUGGINGFACE,
        ]) {
            expect(providerNeedsKey(id)).toBe(true);
        }
    });

    test('bedrock still needs a key, preserving Settings.jsx:509 behaviour', () => {
        expect(providerNeedsKey(LLM_PROVIDERS.BEDROCK)).toBe(true);
    });

    test('a live quota overrides the declared fallback', () => {
        expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, 4096)).toBe(4096);
        expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, null))
            .toBe(CHROME_AI_FALLBACK_CONTEXT_TOKENS);
    });

    test('a live quota is ignored for unconstrained providers', () => {
        expect(effectiveContextTokens(LLM_PROVIDERS.OPENAI, 4096)).toBeNull();
    });

    test('a nonsense live quota falls back rather than trusting it', () => {
        for (const bad of [0, -1, NaN, '8000', undefined]) {
            expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, bad))
                .toBe(CHROME_AI_FALLBACK_CONTEXT_TOKENS);
        }
    });
});

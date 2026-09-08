/**
 * Per-provider capability declarations.
 *
 * This module exists for one provider. Chrome's built-in model has an input
 * quota roughly an order of magnitude smaller than any API model's, and offered
 * as a peer it would be picked for a 40-file review, chunked into fragments,
 * and would answer from a truncated prompt without saying so. Declaring the
 * limit is what lets the UI disable a task with a reason instead of failing
 * quietly.
 *
 * Every other provider is `maxContextTokens: null` — unconstrained, exactly as
 * before. This is not a budget system and should not grow into one.
 */

import { LLM_PROVIDERS } from './constants.js';

/**
 * Pre-session fallback for Chrome's built-in model.
 *
 * Only used before a live session exists. A real session reports `inputQuota`,
 * and that always wins — see `effectiveContextTokens`. Hardcoding this as the
 * truth would go silently wrong the first time Chrome changed it.
 */
export const CHROME_AI_FALLBACK_CONTEXT_TOKENS = 6144;

const UNCONSTRAINED = null;

const KEYLESS = { maxContextTokens: UNCONSTRAINED, supportsTools: true, supportsStreaming: true, needsKey: false };
const KEYED = { maxContextTokens: UNCONSTRAINED, supportsTools: true, supportsStreaming: true, needsKey: true };

const CAPABILITIES = Object.freeze({
    [LLM_PROVIDERS.OPENAI]: KEYED,
    [LLM_PROVIDERS.ANTHROPIC]: KEYED,
    [LLM_PROVIDERS.GOOGLE]: KEYED,
    [LLM_PROVIDERS.COHERE]: KEYED,
    [LLM_PROVIDERS.MISTRAL]: KEYED,
    [LLM_PROVIDERS.PERPLEXITY]: KEYED,
    [LLM_PROVIDERS.GROQ]: KEYED,
    [LLM_PROVIDERS.HUGGINGFACE]: KEYED,
    [LLM_PROVIDERS.OPENROUTER]: KEYED,
    [LLM_PROVIDERS.NVIDIA]: KEYED,
    // Bedrock signs with IAM credentials and shows its own credential block,
    // but Settings.jsx:509 requires a non-empty apiKey for everything except
    // Ollama. Keeping `needsKey: true` preserves that exactly.
    [LLM_PROVIDERS.BEDROCK]: KEYED,
    [LLM_PROVIDERS.LOCAL]: KEYLESS,
    [LLM_PROVIDERS.CHROME_AI]: {
        maxContextTokens: CHROME_AI_FALLBACK_CONTEXT_TOKENS,
        // Nano exposes no tool-calling and no structured tool protocol.
        supportsTools: false,
        supportsStreaming: true,
        needsKey: false,
    },
});

/** Unknown providers are treated as unconstrained and key-requiring — the safe pair. */
const DEFAULT_CAPABILITIES = KEYED;

export function getCapabilities(provider) {
    return CAPABILITIES[provider] || DEFAULT_CAPABILITIES;
}

export function providerNeedsKey(provider) {
    return getCapabilities(provider).needsKey;
}

/**
 * The context ceiling to plan against.
 *
 * @param {string} provider
 * @param {number|null} liveQuota - `session.inputQuota` when a session exists.
 * @returns {number|null} null means unconstrained.
 */
export function effectiveContextTokens(provider, liveQuota) {
    const declared = getCapabilities(provider).maxContextTokens;
    if (declared === UNCONSTRAINED) return UNCONSTRAINED;
    const usable = Number.isInteger(liveQuota) && liveQuota > 0;
    return usable ? liveQuota : declared;
}

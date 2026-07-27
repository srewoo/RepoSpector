/**
 * modelResolver — the single, strict authority on which model a call uses.
 *
 * RULE: the extension only ever calls the model the user selected in Settings
 * (or explicitly pinned in `.repospector.yaml`). There is no default, no
 * fallback, and no inference. If a model cannot be resolved unambiguously the
 * call FAILS with an actionable error.
 *
 * Why this is strict rather than forgiving: a silent fallback spends the user's
 * own API budget on a model they did not choose, and produces review results
 * attributed to the wrong model — which makes any quality measurement
 * meaningless and any cost estimate wrong. Several such fallbacks existed:
 *
 *   LLMService.streamChat  `model || 'openai:gpt-4.1-mini'`
 *   LLMService.getProvider  returned OPENAI for any unprefixed identifier —
 *                           so a bare "claude-sonnet-4" was sent to OpenAI
 *   LLMService.getModelId   returned 'gpt-4.1-mini' for a missing identifier
 *   BackgroundService.getModelId  same
 *
 * A model identifier is canonically `provider:modelId` (e.g. `openai:gpt-4.1`,
 * `anthropic:claude-sonnet-4`, `local:llama3.3`) — the key format used by
 * MODELS in constants.js and written by the Settings UI.
 */

import { MODELS, LLM_PROVIDERS } from './constants.js';

const KNOWN_PROVIDERS = new Set(Object.values(LLM_PROVIDERS));

/** Error type callers can detect to show a "choose a model" prompt. */
export class ModelNotSelectedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ModelNotSelectedError';
        this.code = 'MODEL_NOT_SELECTED';
    }
}

/**
 * Resolve a model identifier into the exact provider + model to call.
 *
 * @param {string} modelIdentifier - e.g. "openai:gpt-4.1-mini"
 * @param {object} [opts]
 * @param {string} [opts.explicitProvider] - provider from settings, used ONLY to
 *        disambiguate an identifier that carries no prefix. Never overrides a
 *        prefix, and never invents one.
 * @param {string} [opts.context] - short label for the error message ("PR review")
 * @returns {{ modelIdentifier: string, provider: string, modelId: string }}
 * @throws {ModelNotSelectedError}
 */
export function resolveModel(modelIdentifier, opts = {}) {
    const { explicitProvider, context = 'this request' } = opts;

    const raw = typeof modelIdentifier === 'string' ? modelIdentifier.trim() : '';
    if (!raw) {
        throw new ModelNotSelectedError(
            `No model is selected for ${context}. Open Settings and choose a provider and model. `
            + `RepoSpector will not fall back to a default model.`
        );
    }

    // Canonical "provider:modelId".
    if (raw.includes(':')) {
        const idx = raw.indexOf(':');
        const provider = raw.slice(0, idx).trim();
        const rest = raw.slice(idx + 1).trim();

        if (!provider || !rest) {
            throw new ModelNotSelectedError(
                `Malformed model identifier "${raw}" for ${context}. Expected "provider:model". `
                + `Re-select the model in Settings.`
            );
        }
        if (!KNOWN_PROVIDERS.has(provider)) {
            throw new ModelNotSelectedError(
                `Unknown provider "${provider}" in model "${raw}" for ${context}. `
                + `Supported: ${[...KNOWN_PROVIDERS].join(', ')}. Re-select the model in Settings.`
            );
        }
        if (explicitProvider && explicitProvider !== provider) {
            // Disagreement means the settings are inconsistent. Guessing which one
            // the user meant is exactly the silent-wrong-model failure to avoid.
            throw new ModelNotSelectedError(
                `Provider mismatch for ${context}: settings say "${explicitProvider}" but the selected `
                + `model is "${raw}". Re-select the model in Settings so the two agree.`
            );
        }

        // Prefer the catalog's modelId (the wire name) when we know the model;
        // otherwise pass the suffix through so custom/self-hosted names work.
        const modelId = MODELS[raw]?.modelId || rest;
        return { modelIdentifier: raw, provider, modelId };
    }

    // Unprefixed identifier — only usable when the provider is stated explicitly.
    // We do NOT assume OpenAI: that is how a bare "claude-sonnet-4" ended up
    // being POSTed to api.openai.com with the user's OpenAI key.
    if (explicitProvider && KNOWN_PROVIDERS.has(explicitProvider)) {
        return { modelIdentifier: `${explicitProvider}:${raw}`, provider: explicitProvider, modelId: raw };
    }

    throw new ModelNotSelectedError(
        `Model "${raw}" for ${context} has no provider prefix and no provider is configured. `
        + `Re-select the model in Settings (expected "provider:model", e.g. "openai:gpt-4.1").`
    );
}

/**
 * Throw unless a usable model is selected. Use at the top of any flow that will
 * spend tokens, so it fails before doing work rather than mid-pipeline.
 */
export function assertModelSelected(modelIdentifier, opts = {}) {
    return resolveModel(modelIdentifier, opts);
}

/** True when a model identifier resolves cleanly. Never throws. */
export function isModelSelected(modelIdentifier, opts = {}) {
    try {
        resolveModel(modelIdentifier, opts);
        return true;
    } catch {
        return false;
    }
}

export default { resolveModel, assertModelSelected, isModelSelected, ModelNotSelectedError };

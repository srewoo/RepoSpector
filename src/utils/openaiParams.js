/**
 * openaiParams — reshape a chat request for OpenAI's reasoning models.
 *
 * OpenAI's o-series and GPT-5 families rejected the parameters every other
 * OpenAI model accepts:
 *
 *   - `max_tokens` is refused outright; the cap is `max_completion_tokens`.
 *   - `temperature`, `top_p` and the penalties are refused (or, on GPT-5,
 *     refused for any value but the default).
 *
 * Both come back as a flat `400 Unsupported parameter` / `Unsupported value`,
 * which the user sees as "OpenAI API error (400)" — indistinguishable from a
 * bad request they wrote themselves, on a model the dropdown offered them.
 *
 * ── Why here, and not at the call sites ──
 *
 * Four call sites send these parameters (chat, direct test generation, batch
 * chunk processing, and the key probe) and every one of them was broken on
 * these models. Fixing them individually leaves the fifth caller to rediscover
 * it, which is the same argument the call budget and the auth tagging make for
 * living at the one choke point every request passes through. The translation
 * therefore happens in the OpenAI adapter, and callers keep speaking one
 * dialect.
 *
 * A model outside these families is returned untouched — not rebuilt, not
 * reordered — so existing requests stay byte-identical.
 */

/**
 * Bare model ids (no `provider:` prefix) that use the newer parameter names.
 *
 * This is deliberately NOT `REASONING_PATTERNS.openai` from
 * `modelCapabilities.js`, even though the two lists happen to be identical
 * today. They answer different questions — "does it think before answering"
 * versus "which parameter names does its endpoint accept" — and the
 * consequences of a wrong entry differ: there, a missed model loses an optional
 * feature; here, a missed model 400s every request. A test asserts the two
 * agree, so adding a family to one prompts a decision about the other rather
 * than a silent divergence.
 */
const NEWER_PARAM_FAMILIES = [
    /^o\d/,      // o1, o3, o3-mini, o4-mini — the reasoning series
    /^gpt-5/,    // GPT-5 family
];

/**
 * Sampling controls the reasoning endpoints refuse.
 *
 * `temperature` is dropped rather than clamped to the one value GPT-5 accepts
 * (1, its default): sending the default explicitly buys nothing, and a clamp
 * would quietly turn a caller's `0.1` into `1` while looking like it honoured
 * it. Dropping it is the same outcome with an honest audit trail.
 */
const UNSUPPORTED_SAMPLING = Object.freeze([
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'logprobs',
    'top_logprobs',
    'logit_bias',
]);

/**
 * Strip a `provider:` prefix, keeping the rest of the id intact.
 *
 * Only the FIRST colon delimits the provider — gateway ids carry their own
 * (`openrouter:deepseek/deepseek-r1:free`).
 */
function bareModelId(model) {
    return String(model ?? '').trim().toLowerCase().replace(/^[^:]+:/, '');
}

/**
 * Does this OpenAI model use `max_completion_tokens` instead of `max_tokens`?
 *
 * @param {string} model - `openai:o4-mini` or a bare `o4-mini`
 * @returns {boolean}
 */
export function usesNewerParams(model) {
    const bare = bareModelId(model);
    if (!bare) return false;
    return NEWER_PARAM_FAMILIES.some(re => re.test(bare));
}

/**
 * Rewrite a request body for whichever parameter dialect the model speaks.
 *
 * @param {Object} requestData - an OpenAI-shaped request
 * @returns {{request: Object, renamed: string[], dropped: string[]}}
 *   `request` is the SAME object when no change is needed, so a caller can
 *   compare by identity to know nothing happened.
 */
export function normalizeOpenAIRequest(requestData) {
    if (!requestData || !usesNewerParams(requestData.model)) {
        return { request: requestData, renamed: [], dropped: [] };
    }

    const request = { ...requestData };
    const renamed = [];
    const dropped = [];

    if ('max_tokens' in request) {
        // An explicit `max_completion_tokens` wins: a caller that already knows
        // the newer name meant it, and silently overwriting it with a legacy
        // `max_tokens` sitting alongside would undo their fix.
        if (request.max_completion_tokens == null) {
            request.max_completion_tokens = request.max_tokens;
            renamed.push('max_tokens→max_completion_tokens');
        } else {
            dropped.push('max_tokens');
        }
        delete request.max_tokens;
    }

    for (const param of UNSUPPORTED_SAMPLING) {
        if (param in request) {
            delete request[param];
            dropped.push(param);
        }
    }

    return { request, renamed, dropped };
}

export default { usesNewerParams, normalizeOpenAIRequest, NEWER_PARAM_FAMILIES };

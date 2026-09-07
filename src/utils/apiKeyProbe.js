/**
 * apiKeyProbe — turn one minimal LLM call into an answer to "is my key good?"
 *
 * ── Why a chat call and not a /models listing ──
 *
 * Listing models proves a key is authentic and nothing else. The failures users
 * actually hit after entering a valid key are all invisible to a listing: an
 * OpenRouter account with no credits, a Bedrock account that has not requested
 * access to the model, an OpenAI key whose project cannot reach the selected
 * model. Those keys list fine and then fail on the first review — which is the
 * worst possible moment to find out, because the review has already spent
 * minutes gathering context.
 *
 * So the probe sends the smallest real request the review would send, to the
 * model the user actually selected.
 *
 * ── Why the result is not a boolean ──
 *
 * "Valid" is not one bit. A 402 from OpenRouter means the key authenticated
 * perfectly and the account is out of money; reporting that as "invalid key"
 * sends the user to regenerate a key that was never the problem. A 404 on the
 * model means the key is fine and the model id is stale. Both are actionable,
 * and each points somewhere different — so the state is an enum and the message
 * names the remedy.
 */

import { isAuthError, describeAuthError } from './authErrors.js';

export const PROBE_STATE = Object.freeze({
    /** The model answered. Nothing else to check. */
    OK: 'ok',
    /** The credential itself was rejected. */
    KEY_INVALID: 'key-invalid',
    /** Key authenticated; the account cannot pay for the call. */
    BILLING: 'billing',
    /** Key authenticated; throttled right now. */
    RATE_LIMITED: 'rate-limited',
    /** Key authenticated; this model is not usable by it. */
    MODEL_UNAVAILABLE: 'model-unavailable',
    /** Never reached the provider — offline, blocked, timed out. */
    UNREACHABLE: 'unreachable',
    /** Reached it, got something we cannot classify. */
    UNKNOWN: 'unknown',
});

/**
 * States in which the CREDENTIAL is known good, whatever else went wrong.
 *
 * The UI needs this distinction to choose between "fix your key" and "your key
 * is fine, fix this other thing".
 */
const KEY_PROVEN_GOOD = new Set([
    PROBE_STATE.OK,
    PROBE_STATE.BILLING,
    PROBE_STATE.RATE_LIMITED,
    PROBE_STATE.MODEL_UNAVAILABLE,
]);

export function keyProven(state) {
    return KEY_PROVEN_GOOD.has(state);
}

/**
 * Pull the HTTP status out of a provider error.
 *
 * Every adapter in `LLMService` formats failures as
 * `"<Provider> API error (403): <body>"`, so the parenthesised form is tried
 * first and is exact. The bare-number fallback exists for Bedrock, whose
 * `describeInvokeError` writes its own prose — but it is deliberately anchored
 * to a small set of statuses, because an unanchored `\d{3}` matches the "403"
 * inside a model id, a token count, or a request id.
 *
 * @returns {number|null}
 */
export function httpStatusOf(error) {
    if (error && Number.isInteger(error.status)) return error.status;
    const raw = (typeof error === 'string' ? error : error?.message) || '';

    const parenthesised = raw.match(/\((\d{3})\)/);
    if (parenthesised) return Number(parenthesised[1]);

    const bare = raw.match(/(?:^|[\s:(])(400|401|402|403|404|408|409|422|429|500|502|503|504)(?:$|[\s:.,)])/);
    return bare ? Number(bare[1]) : null;
}

/**
 * Classify a failed probe.
 *
 * Order matters: the credential verdict is decided BEFORE the status code is
 * consulted, because `isAuthError` is the codebase's own tagged classification
 * (set at the one choke point in `LLMService`) and is more reliable than
 * re-reading a status here. Status is how the non-auth failures are separated
 * from each other.
 *
 * @param {Error|string} error
 * @param {{provider?: string, model?: string}} [ctx]
 * @returns {{state: string, message: string, status: number|null}}
 */
export function classifyProbeFailure(error, { provider = '', model = '' } = {}) {
    const raw = (typeof error === 'string' ? error : error?.message) || 'Unknown error';
    const status = httpStatusOf(error);
    const named = model ? `"${model}"` : 'the selected model';

    if (isAuthError(error) || status === 401) {
        return {
            state: PROBE_STATE.KEY_INVALID,
            message: describeAuthError(error, { provider }),
            status,
        };
    }

    // 403 is genuinely ambiguous — a revoked key and a key without access to
    // one model both produce it. `describeAuthError` already says both things
    // for the 403 case, so defer to it rather than guessing one of them here.
    if (status === 403) {
        return {
            state: PROBE_STATE.MODEL_UNAVAILABLE,
            message: describeAuthError(error, { provider }),
            status,
        };
    }

    if (status === 402 || /insufficient|credit|quota|billing|payment|exceeded your current/i.test(raw)) {
        return {
            state: PROBE_STATE.BILLING,
            message: 'Your key is valid, but the account cannot fund this call — out of credits, '
                + 'quota or an unpaid balance. Top up with the provider; the key itself is fine.',
            status,
        };
    }

    if (status === 429 || /rate.?limit|too many requests/i.test(raw)) {
        return {
            state: PROBE_STATE.RATE_LIMITED,
            message: 'Your key is valid but is being rate-limited right now. Reviews will work '
                + 'once the limit clears.',
            status,
        };
    }

    if (status === 404 || status === 400 || status === 422) {
        return {
            state: PROBE_STATE.MODEL_UNAVAILABLE,
            message: `Your key was accepted, but ${named} rejected the request (${status}). `
                + 'The model id may be retired or unavailable to your account — press '
                + '↻ Refresh models and pick another.',
            status,
        };
    }

    // No status at all: the request never got an HTTP response. An aborted
    // fetch is the timeout, and it is worth naming, because "failed to fetch"
    // reads as a bad key to everyone who has just typed one in.
    if (status === null) {
        if (/abort/i.test(raw) || error?.name === 'AbortError') {
            return {
                state: PROBE_STATE.UNREACHABLE,
                message: 'The provider did not respond in time. This says nothing about your key '
                    + '— try again, or check whether a proxy or firewall is in the way.',
                status,
            };
        }
        if (/failed to fetch|network|dns|econn|socket|offline/i.test(raw)) {
            return {
                state: PROBE_STATE.UNREACHABLE,
                message: `Could not reach the provider (${raw}). This is a connectivity or `
                    + 'permission problem, not a rejected key.',
                status,
            };
        }
    }

    if (status && status >= 500) {
        return {
            state: PROBE_STATE.UNREACHABLE,
            message: `The provider returned a server error (${status}). Your key was not the `
                + 'problem — try again shortly.',
            status,
        };
    }

    return { state: PROBE_STATE.UNKNOWN, message: raw, status };
}

/**
 * The successful case, kept here so both halves of the verdict are written in
 * one place and the UI never has to compose its own wording.
 */
export function describeProbeSuccess({ provider = '', model = '', latencyMs = 0, content = '' } = {}) {
    const where = model || provider || 'the provider';
    // A model that returns an empty completion still proves the key: the call
    // was authorised, billed and answered. Saying "no content" would read as a
    // failure for something that is not one.
    const reply = String(content || '').trim();
    return reply
        ? `${where} replied in ${latencyMs} ms. Your key works.`
        : `${where} accepted the call in ${latencyMs} ms (empty reply). Your key works.`;
}

export default {
    PROBE_STATE,
    keyProven,
    httpStatusOf,
    classifyProbeFailure,
    describeProbeSuccess,
};

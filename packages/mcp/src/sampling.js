/**
 * sampling — borrow the CLIENT's model instead of holding a key.
 *
 * This server is keyless by design, which is why `review_pr` has only ever
 * returned evidence: with no model it cannot form a judgement, so it hands the
 * material to whichever agent called it. Giving it an API key would fix that
 * and introduce a credential on a process a user launches from a config file.
 *
 * MCP sampling is the third option. The server asks the CLIENT to run a
 * completion on its behalf — the client's model, the client's key, the client's
 * consent prompt. Nothing secret ever reaches this process, and the review runs
 * on whatever model the user already chose for their session.
 *
 * The catch, and the reason this module is mostly about failure: sampling is an
 * OPTIONAL client capability and many clients do not implement it. So every
 * path here reports availability as a fact rather than assuming it, and a
 * caller that cannot get a completion must say the check did not run — never
 * that it found nothing. That distinction is the whole point of the
 * completeness contract this project is built around.
 */

/** Why a completion could not be obtained. Reported, never swallowed. */
export const SAMPLING_UNAVAILABLE = Object.freeze({
    NO_CLIENT: 'the client did not advertise the sampling capability',
    NOT_CONNECTED: 'no server connection is available to ask the client through',
    REFUSED: 'the client refused or could not complete the sampling request',
    EMPTY: 'the client returned no usable text',
});

/**
 * Does the connected client support sampling?
 *
 * Read from the capabilities the client advertised at initialize, so this is
 * what the client SAID it can do rather than a guess or a trial call.
 *
 * @returns {{available: boolean, reason: string|null, client: object|null}}
 */
export function samplingStatus(server) {
    if (!server || typeof server.getClientCapabilities !== 'function') {
        return { available: false, reason: SAMPLING_UNAVAILABLE.NOT_CONNECTED, client: null };
    }
    const caps = server.getClientCapabilities();
    if (!caps?.sampling) {
        return { available: false, reason: SAMPLING_UNAVAILABLE.NO_CLIENT, client: caps ?? null };
    }
    return { available: true, reason: null, client: caps };
}

/**
 * Ask the client to run one completion.
 *
 * `maxTokens` is required by the protocol and is a real cost the user pays, so
 * callers pass it deliberately rather than inheriting a default that quietly
 * grows.
 *
 * @returns {Promise<{text: string|null, model: string|null, available: boolean, reason: string|null}>}
 */
export async function requestCompletion(server, {
    system = null,
    prompt,
    maxTokens = 2048,
    temperature = 0,
} = {}) {
    const status = samplingStatus(server);
    if (!status.available) {
        return { text: null, model: null, available: false, reason: status.reason };
    }

    try {
        const result = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: String(prompt) } }],
            ...(system ? { systemPrompt: String(system) } : {}),
            maxTokens,
            temperature,
            // The client decides which model actually serves this. Naming a
            // preference rather than a model id is what lets the user's own
            // session model answer, which is the point of routing through the
            // client at all.
            modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.2 },
        });

        const text = extractText(result);
        if (!text) {
            return { text: null, model: result?.model ?? null, available: true, reason: SAMPLING_UNAVAILABLE.EMPTY };
        }
        return { text, model: result?.model ?? null, available: true, reason: null };
    } catch (e) {
        // A refusal is a legitimate outcome — the user may have declined the
        // prompt — and is reported as "did not run", not as an error state that
        // callers might read as "ran and found nothing".
        return {
            text: null,
            model: null,
            available: false,
            reason: `${SAMPLING_UNAVAILABLE.REFUSED}: ${e?.message || 'unknown'}`,
        };
    }
}

/** MCP returns one content block; older shapes returned an array. Accept both. */
function extractText(result) {
    const content = result?.content;
    if (!content) return null;
    if (Array.isArray(content)) {
        return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim() || null;
    }
    if (content.type === 'text' && typeof content.text === 'string') {
        return content.text.trim() || null;
    }
    return null;
}

export default { samplingStatus, requestCompletion, SAMPLING_UNAVAILABLE };

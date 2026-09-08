/**
 * Chrome built-in AI (Gemini Nano) support logic.
 *
 * Everything here is pure or reads one global, so the provider's decisions are
 * testable by faking `globalThis.LanguageModel` rather than constructing
 * LLMService. The actual call lives in LLMService.callChromeAI.
 */

/** Minimum Chrome version exposing the `LanguageModel` global to extensions. */
export const CHROME_AI_MIN_VERSION = 138;

/**
 * The four states `LanguageModel.availability()` reports. The middle two are
 * the interesting ones: first use pulls a multi-gigabyte model, so a UI that
 * renders them as "loading" hangs forever from the user's point of view.
 */
export const CHROME_AI_AVAILABILITY = Object.freeze({
    AVAILABLE: 'available',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    UNAVAILABLE: 'unavailable',
});

/**
 * Output-language declaration for every `LanguageModel.create()` call.
 *
 * Chrome warns when a request omits this ("An output language should be
 * specified to ensure optimal output quality and properly attest to output
 * safety") and only accepts de, en, es, fr, ja. RepoSpector's prompts and
 * findings are English, so `en` is the honest declaration.
 *
 * Note the option is `expectedOutputs` with a `{type, languages}` shape — there
 * is no `outputLanguage` parameter, despite the warning's phrasing.
 *
 * Exported so the provider call and the settings panel's download both declare
 * the same thing; two literals would let one drift.
 */
export const CHROME_AI_EXPECTED_OUTPUTS = Object.freeze([
    Object.freeze({ type: 'text', languages: ['en'] }),
]);

const KNOWN_STATES = new Set(Object.values(CHROME_AI_AVAILABILITY));

/**
 * @returns {Promise<{state: string, reason: string}>} `reason` is empty unless
 *   the state is UNAVAILABLE, in which case it is displayable copy.
 */
export async function probeChromeAI() {
    const api = globalThis.LanguageModel;
    if (!api || typeof api.availability !== 'function') {
        return {
            state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            reason: `Chrome built-in AI needs Chrome ${CHROME_AI_MIN_VERSION} or newer on supported hardware.`,
        };
    }
    try {
        const state = await api.availability();
        if (!KNOWN_STATES.has(state)) {
            // Forward-compatibility: an unrecognised state is not assumed usable.
            return {
                state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
                reason: `Chrome reported an unrecognised availability state ("${state}").`,
            };
        }
        return { state, reason: '' };
    } catch (error) {
        return {
            state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            reason: `Chrome built-in AI could not be probed: ${error.message}`,
        };
    }
}

/**
 * Split an OpenAI-style message array into Nano's two inputs.
 *
 * Nano takes a system prompt via `initialPrompts` and a single prompt string.
 * Multiple system messages are joined, matching how buildAnthropicSystem
 * already treats them, so provider swaps do not change the system text.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{system: string, prompt: string}}
 */
export function shapeChromeAIPrompt(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const system = list
        .filter((m) => m && m.role === 'system')
        .map((m) => m.content || '')
        .join('\n\n');

    const turns = list.filter((m) => m && m.role !== 'system');
    // Turns are labelled because Nano gets one flat string, and an unlabelled
    // concatenation of a multi-turn exchange reads as one confused message.
    const prompt = turns
        .map((m) => (turns.length > 1 ? `${m.role}: ${m.content || ''}` : (m.content || '')))
        .join('\n\n');

    return { system, prompt };
}

/**
 * Rough token count for quota checks.
 *
 * Four characters per token is the standard approximation. Only used when the
 * session cannot measure input itself; `measureInputUsage` is preferred and
 * exact where available.
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

/** Thrown instead of letting the API truncate a prompt and answer anyway. */
export class ChromeAIQuotaError extends Error {
    constructor({ promptTokens, quota, task }) {
        super(
            `Prompt is too large for Chrome built-in AI: ~${promptTokens} tokens `
            + `against a ${quota}-token quota (task: ${task || 'unknown'}). `
            + `Pick Ollama or an API provider for this task.`
        );
        this.name = 'ChromeAIQuotaError';
        this.promptTokens = promptTokens;
        this.quota = quota;
        this.task = task || null;
    }
}

/**
 * Refuse an over-quota prompt.
 *
 * Silent truncation is the specific failure the capability system exists to
 * prevent, so it must not be reachable by a caller that bypassed the UI gate.
 * An unknown quota is not treated as zero — we let the call proceed and let the
 * API speak for itself.
 */
export function assertFitsQuota({ promptTokens, quota, task }) {
    if (!Number.isInteger(quota) || quota <= 0) return;
    if (promptTokens <= quota) return;
    throw new ChromeAIQuotaError({ promptTokens, quota, task });
}

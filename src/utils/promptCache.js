/**
 * promptCache — decide what to mark as a cacheable prompt prefix, and read back
 * whether the provider actually cached it.
 *
 * A single PR review makes dozens of LLM calls that share a large identical
 * prefix: the per-file pass runs once per review unit against the same system
 * prompt, the multi-finder pass runs one call per lens per round, and the
 * verification and scoring passes run one call per batch. Every one of those
 * re-sends and re-pays for the same instructions. On BYOK that is the user's
 * own money.
 *
 * Anthropic needs an explicit `cache_control` breakpoint; OpenAI-compatible
 * providers cache automatically on a stable prefix. Both share one hard rule,
 * and it is the whole reason this module is careful about ORDER rather than
 * just markers:
 *
 *   Caching is a PREFIX match. One byte of drift anywhere before the
 *   breakpoint invalidates everything after it.
 *
 * So a marker is necessary but not sufficient — the prompt builders must also
 * put stable content first and per-call content last. Two of them did not, and
 * the fixes live next to this module's use sites (see `finderLensPrompts` and
 * `multiPassPrompts`).
 *
 * Pure and synchronous: no I/O, no provider calls, so the policy is unit
 * testable without an API key.
 */

/**
 * Rough token estimate. Deliberately a heuristic — the only decision it feeds
 * is "is this prefix plausibly above the provider's minimum", and the failure
 * mode on either side is mild (a marker that does nothing, or a missed cache).
 * Paying for a real tokenizer in a service worker to sharpen that is not worth
 * the bundle size.
 *
 * ~4 chars/token is the usual English-plus-code approximation.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

/**
 * Minimum prefix length that any current Anthropic model will cache.
 *
 * The real minimum is model-dependent and NOT monotonic across generations —
 * 512 tokens on the newest models, 1024 on most, but 2048 and even 4096 on some
 * older ones. Below the minimum a `cache_control` marker is silently ignored:
 * no error, just `cache_creation_input_tokens: 0`.
 *
 * We use 1024 rather than the 512 floor deliberately. Marking a prefix that is
 * never read costs a 1.25x write premium, so the threshold should sit where a
 * cache read is near-certain. In this codebase a system prompt that clears 1024
 * tokens only occurs in the review pipeline, which by construction makes many
 * calls against it. Short prompts (chat, doc generation, one-off analysis) fall
 * below the bar and are left unmarked, which is the correct outcome for them.
 */
export const MIN_CACHEABLE_TOKENS = 1024;

/**
 * Should this prefix carry a cache breakpoint?
 *
 * @param {string} text - the full prefix that would be cached
 * @param {Object} [opts]
 * @param {number} [opts.minTokens=MIN_CACHEABLE_TOKENS]
 * @returns {boolean}
 */
export function isWorthCaching(text, opts = {}) {
    const min = opts.minTokens ?? MIN_CACHEABLE_TOKENS;
    return estimateTokens(text) >= min;
}

/**
 * Build Anthropic's `system` field from the system messages of a chat array.
 *
 * Anthropic accepts `system` as either a bare string or an array of text
 * blocks, and `cache_control` can only go on a block. So the breakpoint is the
 * reason to use the array form at all.
 *
 * Each system message becomes its own block, preserving order, and the
 * breakpoint goes on the LAST one — which caches every block before it too,
 * since the match is a prefix. That is what lets a caller split "stable
 * instructions" and "large stable context" across two system messages and have
 * both covered by one marker.
 *
 * Returns `null` when there are no system messages, so the caller can omit the
 * field entirely rather than sending an empty one.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [opts]
 * @param {boolean} [opts.cache=true] - false disables the breakpoint outright
 * @param {number} [opts.minTokens]
 * @returns {string|Array<Object>|null}
 */
export function buildAnthropicSystem(messages = [], opts = {}) {
    const { cache = true } = opts;

    const texts = (messages || [])
        .filter(m => m && m.role === 'system')
        .map(m => String(m.content ?? ''))
        .filter(t => t.length > 0);

    if (texts.length === 0) return null;

    const combined = texts.join('\n\n');
    if (!cache || !isWorthCaching(combined, opts)) {
        // Below the minimum a marker would be ignored anyway; send the cheaper
        // string form so the request body stays identical to what it was.
        return combined;
    }

    const blocks = texts.map(text => ({ type: 'text', text }));
    blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
    return blocks;
}

/**
 * Flatten a message's content to the plain string every non-Anthropic provider
 * expects.
 *
 * Content may be a string (the common case, unchanged) or an array of
 * `{ text, cache }` parts. The parts exist only to place a breakpoint; the
 * concatenation is exactly the string the caller would otherwise have built, so
 * providers that cache automatically see a byte-identical prompt.
 *
 * @param {string|Array<{text: string}>} content
 * @returns {string}
 */
export function flattenContent(content) {
    if (Array.isArray(content)) {
        return content.map(p => String(p?.text ?? '')).join('');
    }
    return String(content ?? '');
}

/**
 * Is this content already a list of provider content blocks (`tool_result`,
 * `tool_use`, `image`, …) rather than the `{ text, cache }` parts this module
 * defines?
 *
 * Tool loops put real Anthropic blocks in `content`, and those must pass
 * through untouched. Without this check `toAnthropicContent` would look for a
 * `.text` on each, find none, and return an empty string — silently deleting
 * every tool result and leaving the model's own tool calls unanswered.
 *
 * @param {Array} content
 * @returns {boolean}
 */
function isProviderBlocks(content) {
    return content.some(p => p && typeof p === 'object' && typeof p.type === 'string');
}

/**
 * Convert a message's content to Anthropic's wire format, honouring a
 * breakpoint requested on one of its parts.
 *
 * The breakpoint is what makes user-message caching possible at all, and that
 * matters more than the system field here: in this codebase the large stable
 * blocks — the diff, the standards, the language rules — live in the user turn,
 * while every system prompt is a few hundred tokens, comfortably under the
 * minimum. Marking only the system field would have been a no-op.
 *
 * A part is marked only if everything up to and including it clears the
 * minimum; otherwise the marker would be silently ignored and the block form
 * would be pure overhead.
 *
 * @param {string|Array<{text: string, cache?: boolean}>} content
 * @param {Object} [opts]
 * @param {boolean} [opts.cache=true]
 * @param {string} [opts.prefixText=''] - text rendered BEFORE this message
 *        (system prompt, earlier turns) that also counts toward the minimum
 * @returns {string|Array<Object>}
 */
export function toAnthropicContent(content, opts = {}) {
    const { cache = true, prefixText = '' } = opts;

    if (!Array.isArray(content)) return String(content ?? '');
    // Already provider blocks (tool results, images) — not ours to rewrite.
    if (isProviderBlocks(content)) return content;
    if (!cache) return flattenContent(content);

    const blocks = [];
    let running = String(prefixText || '');
    let marked = false;

    for (const part of content) {
        const text = String(part?.text ?? '');
        if (!text) continue;
        running += text;
        const block = { type: 'text', text };
        if (part?.cache && !marked && isWorthCaching(running, opts)) {
            block.cache_control = { type: 'ephemeral' };
            marked = true;
        }
        blocks.push(block);
    }

    if (blocks.length === 0) return '';
    // No part cleared the minimum — send the plain string so the request body
    // is identical to what it was before parts existed.
    if (!marked) return flattenContent(content);
    return blocks;
}

/**
 * Normalize provider-reported cache usage into one shape.
 *
 * Worth surfacing rather than discarding: a cache that silently stops working
 * looks exactly like a cache that works, except on the bill. `cacheRead`
 * staying at 0 across a run is the signal that a prefix drifted.
 *
 * Note Anthropic's `input_tokens` counts ONLY the uncached remainder — the
 * cached tokens are reported separately and must be added back to get the true
 * prompt size. OpenAI's `prompt_tokens` is the opposite: it is the total, with
 * the cached portion broken out as a subset. Callers that sum `input` across
 * providers are therefore comparing different quantities; `promptTotal` below
 * is the reconciled figure.
 *
 * @param {Object} usage - raw provider usage object
 * @param {string} provider - 'anthropic' | 'openai' | 'groq' | 'mistral' | ...
 * @returns {{cacheWrite: number, cacheRead: number, promptTotal: number}}
 */
export function extractCacheUsage(usage, provider) {
    const u = usage || {};

    if (provider === 'anthropic') {
        const write = u.cache_creation_input_tokens ?? 0;
        const read = u.cache_read_input_tokens ?? 0;
        const uncached = u.input_tokens ?? 0;
        return {
            cacheWrite: write,
            cacheRead: read,
            promptTotal: uncached + write + read,
        };
    }

    // OpenAI-compatible providers report the cached slice inside the total.
    const total = u.prompt_tokens ?? 0;
    const read = u.prompt_tokens_details?.cached_tokens ?? 0;
    return { cacheWrite: 0, cacheRead: read, promptTotal: total };
}

export default {
    estimateTokens,
    isWorthCaching,
    buildAnthropicSystem,
    flattenContent,
    toAnthropicContent,
    extractCacheUsage,
    MIN_CACHEABLE_TOKENS,
};

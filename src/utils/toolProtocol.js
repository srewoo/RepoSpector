/**
 * toolProtocol — one tool-call shape, whatever the provider.
 *
 * Anthropic and the OpenAI-compatible providers disagree on every part of tool
 * use: where the schema lives, how a call comes back, and how a result goes
 * forward. Without a translation layer that disagreement leaks into the loop
 * that drives the tools, and the loop ends up written twice.
 *
 *   definition   OpenAI: {type:'function', function:{name, description, parameters}}
 *                Anthropic: {name, description, input_schema}
 *   call         OpenAI: message.tool_calls[] with `arguments` as a JSON STRING
 *                Anthropic: a `tool_use` content block with `input` already parsed
 *   result       OpenAI: {role:'tool', tool_call_id, content}
 *                Anthropic: a user turn holding `tool_result` blocks
 *
 * Callers here speak the OpenAI definition shape (it is the one most providers
 * take) and a single normalized call shape: `{ id, name, args }`.
 *
 * Everything is defensive. A model can and does emit malformed tool arguments —
 * truncated JSON, a bare string, the wrong type. That must degrade to "this
 * call had no usable arguments", never to a thrown exception that kills a
 * review the user is waiting on.
 */

/**
 * Parse a tool call's arguments without trusting them.
 *
 * @param {string|Object} raw
 * @returns {Object} always an object, `{}` when unparseable
 */
export function parseToolArgs(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Normalize OpenAI-family `tool_calls` into `{ id, name, args }`.
 *
 * @param {Array} toolCalls
 * @returns {Array<{id: string, name: string, args: Object}>}
 */
export function normalizeOpenAIToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls
        .map((c, i) => ({
            id: c?.id || `call_${i}`,
            name: c?.function?.name || c?.name || '',
            args: parseToolArgs(c?.function?.arguments ?? c?.arguments),
        }))
        .filter(c => c.name);
}

/**
 * Normalize Anthropic `tool_use` content blocks into `{ id, name, args }`.
 *
 * @param {Array} content - the response's content block array
 * @returns {Array<{id: string, name: string, args: Object}>}
 */
export function normalizeAnthropicToolCalls(content) {
    if (!Array.isArray(content)) return [];
    return content
        .filter(b => b?.type === 'tool_use')
        .map((b, i) => ({
            id: b.id || `call_${i}`,
            name: b.name || '',
            args: parseToolArgs(b.input),
        }))
        .filter(c => c.name);
}

/**
 * Build the messages that carry tool results back to the model.
 *
 * Returns an ARRAY because the two families disagree on cardinality: OpenAI
 * wants one `role:'tool'` message per call, Anthropic wants a single user turn
 * holding every `tool_result` block. Splitting Anthropic's results across turns
 * is a protocol error, and merging OpenAI's loses the `tool_call_id` mapping.
 *
 * @param {string} provider
 * @param {Array<{id: string, name: string, result: string}>} results
 * @returns {Array<Object>} messages to append
 */
export function buildToolResultMessages(provider, results) {
    const list = (results || []).filter(Boolean);
    if (list.length === 0) return [];

    if (provider === 'anthropic') {
        return [{
            role: 'user',
            content: list.map(r => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: String(r.result ?? ''),
            })),
        }];
    }

    return list.map(r => ({
        role: 'tool',
        tool_call_id: r.id,
        name: r.name,
        content: String(r.result ?? ''),
    }));
}

/**
 * The assistant turn to echo back before the tool results.
 *
 * Both protocols require the model to see its own tool-call turn again; drop it
 * and the results reference calls that, as far as the next request is
 * concerned, were never made.
 *
 * @param {string} provider
 * @param {Object} response - a normalized LLMService response
 * @returns {Object|null}
 */
export function buildAssistantEcho(provider, response) {
    if (provider === 'anthropic') {
        return response?.raw?.content ? response.raw : null;
    }
    const raw = response?.raw;
    if (!raw) return null;
    return {
        role: 'assistant',
        content: raw.content ?? '',
        tool_calls: raw.tool_calls || [],
    };
}

export default {
    parseToolArgs,
    normalizeOpenAIToolCalls,
    normalizeAnthropicToolCalls,
    buildToolResultMessages,
    buildAssistantEcho,
};

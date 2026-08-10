const {
    parseToolArgs,
    normalizeOpenAIToolCalls,
    normalizeAnthropicToolCalls,
    buildToolResultMessages,
    buildAssistantEcho,
} = require('../../src/utils/toolProtocol.js');

describe('parseToolArgs', () => {
    it('parses a JSON string, which is how OpenAI sends arguments', () => {
        expect(parseToolArgs('{"path":"src/a.js"}')).toEqual({ path: 'src/a.js' });
    });

    it('passes an object through, which is how Anthropic sends them', () => {
        expect(parseToolArgs({ path: 'src/a.js' })).toEqual({ path: 'src/a.js' });
    });

    it('returns an empty object for malformed JSON rather than throwing', () => {
        // Models truncate their own tool arguments. That has to degrade to "no
        // usable arguments", not kill a review the user is waiting on.
        expect(parseToolArgs('{"path":"src/a.js"')).toEqual({});
        expect(parseToolArgs('not json at all')).toEqual({});
    });

    it('rejects non-object JSON', () => {
        expect(parseToolArgs('[1,2,3]')).toEqual({});
        expect(parseToolArgs('"a string"')).toEqual({});
        expect(parseToolArgs('null')).toEqual({});
    });

    it('handles absent input', () => {
        expect(parseToolArgs(undefined)).toEqual({});
        expect(parseToolArgs('')).toEqual({});
    });
});

describe('normalizeOpenAIToolCalls', () => {
    it('flattens the nested function shape', () => {
        expect(normalizeOpenAIToolCalls([
            { id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
        ])).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.js' } }]);
    });

    it('synthesises an id when the provider omits one', () => {
        expect(normalizeOpenAIToolCalls([{ function: { name: 'x', arguments: '{}' } }])[0].id)
            .toBe('call_0');
    });

    it('drops entries with no tool name', () => {
        expect(normalizeOpenAIToolCalls([{ id: 'a', function: { arguments: '{}' } }])).toEqual([]);
    });

    it('returns an empty array when there were no calls', () => {
        expect(normalizeOpenAIToolCalls(undefined)).toEqual([]);
        expect(normalizeOpenAIToolCalls(null)).toEqual([]);
    });
});

describe('normalizeAnthropicToolCalls', () => {
    it('picks tool_use blocks out of mixed content', () => {
        expect(normalizeAnthropicToolCalls([
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', id: 'toolu_1', name: 'find_callers', input: { symbol: 'save' } },
        ])).toEqual([{ id: 'toolu_1', name: 'find_callers', args: { symbol: 'save' } }]);
    });

    it('returns empty when the model only produced text', () => {
        expect(normalizeAnthropicToolCalls([{ type: 'text', text: 'done' }])).toEqual([]);
    });

    it('returns empty for absent content', () => {
        expect(normalizeAnthropicToolCalls(undefined)).toEqual([]);
    });
});

describe('buildToolResultMessages', () => {
    const results = [
        { id: 'c1', name: 'read_file', result: 'contents A' },
        { id: 'c2', name: 'find_callers', result: 'contents B' },
    ];

    it('gives Anthropic ONE user turn holding every result block', () => {
        // Splitting them across turns is a protocol error.
        const msgs = buildToolResultMessages('anthropic', results);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('user');
        expect(msgs[0].content).toHaveLength(2);
        expect(msgs[0].content[0]).toEqual({
            type: 'tool_result', tool_use_id: 'c1', content: 'contents A',
        });
    });

    it('gives OpenAI one tool message per call', () => {
        // Merging them would lose the tool_call_id mapping.
        const msgs = buildToolResultMessages('openai', results);
        expect(msgs).toHaveLength(2);
        expect(msgs[0]).toEqual({
            role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'contents A',
        });
    });

    it('returns nothing for no results', () => {
        expect(buildToolResultMessages('openai', [])).toEqual([]);
        expect(buildToolResultMessages('anthropic', undefined)).toEqual([]);
    });
});

describe('buildAssistantEcho', () => {
    it('echoes Anthropic content blocks verbatim, keeping tool_use', () => {
        // Rebuilding from text alone would drop the tool_use blocks and orphan
        // the results that reference them.
        const raw = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] };
        expect(buildAssistantEcho('anthropic', { raw })).toBe(raw);
    });

    it('rebuilds the OpenAI assistant turn with its tool_calls', () => {
        const echo = buildAssistantEcho('openai', {
            raw: { content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
        });
        expect(echo.role).toBe('assistant');
        expect(echo.tool_calls).toHaveLength(1);
        expect(echo.content).toBe('');
    });

    it('returns null when there is nothing to echo', () => {
        expect(buildAssistantEcho('anthropic', {})).toBeNull();
        expect(buildAssistantEcho('openai', {})).toBeNull();
    });
});

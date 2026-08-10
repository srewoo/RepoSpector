/**
 * The wire format LLMService actually sends.
 *
 * The unit tests around `promptCache` prove the policy; this proves the
 * transport applies it — and, just as importantly, that the providers WITHOUT a
 * breakpoint format still receive exactly the string they received before
 * content parts existed. A caching change that quietly alters the prompt text
 * for five of six providers would be a far worse bug than a missed cache.
 */

const { LLMService } = require('../../src/services/LLMService.js');
const { MIN_CACHEABLE_TOKENS } = require('../../src/utils/promptCache.js');

const BIG = 'x'.repeat(MIN_CACHEABLE_TOKENS * 4 + 100);

/** Capture the JSON body of the single fetch the call makes. */
function captureBody() {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
            ok: true,
            json: async () => ({
                // Shapes for both families; each provider reads only its own.
                content: [{ type: 'text', text: 'ok' }],
                choices: [{ message: { content: 'ok' } }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 2,
                    cache_creation_input_tokens: 1024,
                    cache_read_input_tokens: 0,
                    prompt_tokens: 1234,
                    completion_tokens: 2,
                    prompt_tokens_details: { cached_tokens: 1024 },
                },
            }),
        };
    });
    return calls;
}

describe('Anthropic wire format', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });
    afterEach(() => { delete global.fetch; });

    it('marks the cacheable part of a user message', async () => {
        const calls = captureBody();
        await svc.streamChat(
            [
                { role: 'system', content: 'short instructions' },
                { role: 'user', content: [{ text: BIG, cache: true }, { text: 'tail' }] },
            ],
            { model: 'anthropic:claude-opus-5', apiKey: 'k' },
        );

        const [{ body }] = calls;
        const content = body.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(content[1].cache_control).toBeUndefined();
        // The text itself is untouched.
        expect(content.map(b => b.text).join('')).toBe(BIG + 'tail');
    });

    it('counts the system prompt toward the minimum for a user breakpoint', async () => {
        // Half the minimum in each. Neither clears the bar alone; the system
        // prompt renders first, so together they do.
        const half = 'y'.repeat(MIN_CACHEABLE_TOKENS * 2 + 8);
        const calls = captureBody();
        await svc.streamChat(
            [
                { role: 'system', content: half },
                { role: 'user', content: [{ text: half, cache: true }] },
            ],
            { model: 'anthropic:claude-opus-5', apiKey: 'k' },
        );

        const content = calls[0].body.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('sends a plain string when nothing clears the minimum', async () => {
        const calls = captureBody();
        await svc.streamChat(
            [
                { role: 'system', content: 'be brief' },
                { role: 'user', content: [{ text: 'hello ', cache: true }, { text: 'world' }] },
            ],
            { model: 'anthropic:claude-opus-5', apiKey: 'k' },
        );

        const { body } = calls[0];
        expect(body.system).toBe('be brief');
        expect(body.messages[0].content).toBe('hello world');
    });

    it('reports cache usage back to the caller', async () => {
        captureBody();
        const resp = await svc.streamChat(
            [{ role: 'user', content: 'hi' }],
            { model: 'anthropic:claude-opus-5', apiKey: 'k' },
        );
        expect(resp.usage.cacheWrite).toBe(1024);
        expect(resp.usage.cacheRead).toBe(0);
        // `input` is the whole prompt, so the dozen call sites that sum it keep
        // reporting prompt size rather than appearing to shrink by whatever
        // caching saved. Anthropic's own uncached-remainder figure is kept
        // under its own name.
        expect(resp.usage.input).toBe(10 + 1024 + 0);
        expect(resp.usage.promptTotal).toBe(10 + 1024 + 0);
        expect(resp.usage.inputUncached).toBe(10);
    });

    it('honours an explicit cachePrompt opt-out', async () => {
        const calls = captureBody();
        await svc.callLLM(
            {
                model: 'anthropic:claude-opus-5',
                messages: [{ role: 'user', content: [{ text: BIG, cache: true }] }],
            },
            'k',
            { cachePrompt: false },
        );
        expect(typeof calls[0].body.messages[0].content).toBe('string');
    });
});

describe('tool wire format', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });
    afterEach(() => { delete global.fetch; });

    const TOOLS = [{
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
    }];

    it('translates OpenAI-shaped tools into Anthropic\'s input_schema form', async () => {
        const calls = captureBody();
        await svc.streamChat(
            [{ role: 'user', content: 'go' }],
            { model: 'anthropic:claude-opus-5', apiKey: 'k', tools: TOOLS },
        );
        const [tool] = calls[0].body.tools;
        expect(tool.name).toBe('read_file');
        expect(tool.input_schema.required).toEqual(['path']);
        expect(tool.function).toBeUndefined();
    });

    it('passes tools through unchanged for OpenAI', async () => {
        const calls = captureBody();
        await svc.streamChat(
            [{ role: 'user', content: 'go' }],
            { model: 'openai:gpt-5', apiKey: 'k', tools: TOOLS },
        );
        expect(calls[0].body.tools).toEqual(TOOLS);
    });

    it('omits the tools field entirely when none are supplied', async () => {
        const calls = captureBody();
        await svc.streamChat([{ role: 'user', content: 'go' }], { model: 'openai:gpt-5', apiKey: 'k' });
        expect(calls[0].body.tools).toBeUndefined();
    });

    it('preserves Anthropic tool_result blocks instead of flattening them away', async () => {
        // The content-parts machinery only understands {text, cache}. Applied to
        // real provider blocks it would find no `.text`, emit nothing, and leave
        // the model's own tool calls unanswered.
        const calls = captureBody();
        await svc.streamChat(
            [
                { role: 'user', content: 'go' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
            ],
            { model: 'anthropic:claude-opus-5', apiKey: 'k', tools: TOOLS },
        );

        const msgs = calls[0].body.messages;
        expect(msgs[1].content[0].type).toBe('tool_use');
        expect(msgs[2].content[0]).toEqual({
            type: 'tool_result', tool_use_id: 't1', content: 'file body',
        });
    });

    it('normalizes tool calls from both providers to one shape', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.js' } }],
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
                    },
                }],
                usage: {},
            }),
        }));

        const anthropic = await svc.streamChat([{ role: 'user', content: 'go' }],
            { model: 'anthropic:claude-opus-5', apiKey: 'k', tools: TOOLS });
        const openai = await svc.streamChat([{ role: 'user', content: 'go' }],
            { model: 'openai:gpt-5', apiKey: 'k', tools: TOOLS });

        expect(anthropic.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', args: { path: 'a.js' } }]);
        expect(openai.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.js' } }]);
    });

    it('reports an empty toolCalls array when the model just answered', async () => {
        captureBody();
        const resp = await svc.streamChat([{ role: 'user', content: 'go' }],
            { model: 'openai:gpt-5', apiKey: 'k' });
        expect(resp.toolCalls).toEqual([]);
    });
});

describe('providers without a breakpoint format', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });
    afterEach(() => { delete global.fetch; });

    it.each([
        ['openai', 'openai:gpt-5'],
        ['groq', 'groq:llama-3.3-70b-versatile'],
        ['mistral', 'mistral:mistral-large-latest'],
    ])('%s receives the parts joined into one string', async (_name, model) => {
        const calls = captureBody();
        await svc.streamChat(
            [{ role: 'user', content: [{ text: BIG, cache: true }, { text: 'tail' }] }],
            { model, apiKey: 'k' },
        );

        const msg = calls[0].body.messages[0];
        expect(typeof msg.content).toBe('string');
        expect(msg.content).toBe(BIG + 'tail');
        // No Anthropic-only field leaks into an OpenAI-shaped body.
        expect(JSON.stringify(calls[0].body)).not.toContain('cache_control');
    });

    it('surfaces OpenAI\'s automatically cached token count', async () => {
        captureBody();
        const resp = await svc.streamChat(
            [{ role: 'user', content: 'hi' }],
            { model: 'openai:gpt-5', apiKey: 'k' },
        );
        expect(resp.usage.cacheRead).toBe(1024);
        expect(resp.usage.cacheWrite).toBe(0);
        expect(resp.usage.promptTotal).toBe(1234);
    });

    it('keeps several system messages instead of dropping all but the last', async () => {
        // The Gemini path assigned rather than accumulated, so a second system
        // message silently discarded the first — including, now, the stable
        // instructions a caller splits out to form a cacheable prefix.
        const calls = captureBody();
        await svc.streamChat(
            [
                { role: 'system', content: 'first rules' },
                { role: 'system', content: 'second rules' },
                { role: 'user', content: 'hi' },
            ],
            { model: 'google:gemini-2.5-pro', apiKey: 'k' },
        );

        const parts = calls[0].body.systemInstruction.parts;
        expect(parts.map(p => p.text)).toEqual(['first rules', 'second rules']);
    });
});

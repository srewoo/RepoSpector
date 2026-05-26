/**
 * LLMClient unit tests. Uses Node's built-in `node:test` runner — no
 * jest, no transpiler. Fetch is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/services/llmClient.js';

function makeFetch(impl) {
    return async (url, opts) => impl(url, opts);
}
function jsonResponse(body, status = 200) {
    return {
        ok: status < 400,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

test('constructor guards', () => {
    assert.throws(() => new LLMClient({}), /provider/);
    assert.throws(() => new LLMClient({ provider: 'openai' }), /model/);
    assert.throws(() => new LLMClient({ provider: 'openai', model: 'gpt-4o-mini' }), /apiKey/);
});

test('stripProviderPrefix on model', () => {
    const fetch = makeFetch(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.model, 'gpt-4o-mini'); // prefix stripped
        return jsonResponse({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
    });
    const c = new LLMClient({ provider: 'openai', model: 'openai:gpt-4o-mini', apiKey: 'k', fetch });
    return c.chat([{ role: 'user', content: 'hi' }]).then((r) => {
        assert.equal(r.content, 'ok');
        assert.equal(r.tokensIn, 10);
        assert.equal(r.tokensOut, 5);
        assert.ok(r.costCents >= 0);
    });
});

test('OpenAI-compat happy path returns content + tokens + cost', async () => {
    const fetch = makeFetch(async (url, opts) => {
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(opts.headers.Authorization, 'Bearer sk-test');
        const body = JSON.parse(opts.body);
        assert.equal(body.response_format.type, 'json_object');
        return jsonResponse({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 500 },
        });
    });
    const c = new LLMClient({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', fetch });
    const r = await c.chat([{ role: 'user', content: 'x' }], { jsonMode: true });
    assert.equal(r.content, '{"ok":true}');
    assert.equal(r.tokensIn, 1000);
    assert.equal(r.tokensOut, 500);
    assert.ok(r.costCents > 0);
});

test('Anthropic adapter routes system separately', async () => {
    const fetch = makeFetch(async (url, opts) => {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(opts.headers['x-api-key'], 'akey');
        assert.equal(opts.headers['anthropic-version'], '2023-06-01');
        const body = JSON.parse(opts.body);
        assert.equal(body.system, 'you are reviewer');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
        return jsonResponse({
            content: [{ type: 'text', text: 'reviewed' }],
            usage: { input_tokens: 12, output_tokens: 3 },
            stop_reason: 'end_turn',
        });
    });
    const c = new LLMClient({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'akey', fetch });
    const r = await c.chat([
        { role: 'system', content: 'you are reviewer' },
        { role: 'user', content: 'hi' },
    ]);
    assert.equal(r.content, 'reviewed');
    assert.equal(r.tokensIn, 12);
    assert.equal(r.tokensOut, 3);
});

test('Google adapter reshapes role + uses systemInstruction', async () => {
    const fetch = makeFetch(async (url, opts) => {
        assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-1\.5-flash:generateContent\?key=/);
        const body = JSON.parse(opts.body);
        assert.equal(body.systemInstruction.parts[0].text, 'system text');
        assert.equal(body.contents[0].role, 'user');
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
        return jsonResponse({
            candidates: [{
                content: { parts: [{ text: '{"ok":true}' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
        });
    });
    const c = new LLMClient({ provider: 'google', model: 'gemini-1.5-flash', apiKey: 'gkey', fetch });
    const r = await c.chat([
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'hi' },
    ], { jsonMode: true });
    assert.equal(r.content, '{"ok":true}');
    assert.equal(r.tokensIn, 50);
    assert.equal(r.tokensOut, 10);
});

test('retries on 429 with backoff', async () => {
    let calls = 0;
    const fetch = makeFetch(async () => {
        calls++;
        if (calls < 2) return jsonResponse({ error: 'rate_limited' }, 429);
        return jsonResponse({
            choices: [{ message: { content: 'after retry' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
    });
    const c = new LLMClient({
        provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', fetch,
        sleep: async () => {}, // collapse backoff
    });
    const r = await c.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r.content, 'after retry');
    assert.equal(calls, 2);
});

test('does not retry on 4xx (non-429)', async () => {
    let calls = 0;
    const fetch = makeFetch(async () => {
        calls++;
        return jsonResponse({ error: 'bad request' }, 400);
    });
    const c = new LLMClient({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', fetch });
    await assert.rejects(c.chat([{ role: 'user', content: 'x' }]), /400/);
    assert.equal(calls, 1);
});

test('unsupported provider rejects', async () => {
    const c = new LLMClient({ provider: 'aleph-one', model: 'm', apiKey: 'k', fetch: async () => ({}) });
    await assert.rejects(c.chat([{ role: 'user', content: 'x' }]), /unsupported_provider|Unknown provider/i);
});

test('timeout maps to a clean error', async () => {
    const fetch = async (_url, opts) => {
        return new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
            });
        });
    };
    const c = new LLMClient({
        provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', fetch, timeoutMs: 50,
    });
    await assert.rejects(c.chat([{ role: 'user', content: 'x' }]), /timeout/);
});

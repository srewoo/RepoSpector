import { describe, expect, it } from 'vitest';
import { createProvider, estimateCost, PRESETS, PRICES_AS_OF, ProviderError } from '../src/providers/index.js';

type Seen = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(reply: { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = url instanceof Request ? url.url : String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    // The SDK may pass a Request or a plain init; normalise so headers are read the same way.
    const headers = new Headers(url instanceof Request ? url.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    seen.push({ url: u, init: { ...(init ?? {}), headers }, body });
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
  };
  return { impl: impl as typeof fetch, seen };
}

const header = (s: Seen | undefined, name: string): string | null => new Headers(s?.init.headers).get(name);
const REQ = { system: 'S', prompt: 'P', maxTokens: 1000, effort: 'high' as const };

describe('presets', () => {
  it('names a model and a dated price for every provider and preset', () => {
    expect(PRICES_AS_OF).toBe('2026-11-21');
    expect(PRESETS.anthropic.best.model).toBe('claude-opus-5-5');
    expect(PRESETS.anthropic.balanced.model).toBe('claude-sonnet-5-5');
    expect(PRESETS.anthropic.low.model).toBe('claude-haiku-5-5');
    for (const p of ['anthropic', 'openai', 'gemini'] as const) for (const t of ['best', 'balanced', 'low'] as const) expect(PRESETS[p][t].inPerM).toBeGreaterThan(0);
  });

  it('estimates cost from token counts', () => {
    expect(estimateCost(PRESETS.anthropic.best, 100_000, 10_000)).toBeCloseTo(0.4 + 0.2, 6);
  });
});

describe('Anthropic provider (official SDK)', () => {
  const ok = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 3 } };

  it('sends key, effort and default fallbacks for Opus 5.5, and returns text and usage', async () => {
    const f = fakeFetch({ json: ok });
    const p = createProvider({ id: 'anthropic', apiKey: 'sk-ant-x', model: 'claude-opus-5-5', fetchImpl: f.impl });
    const r = await p.complete(REQ);
    expect(r).toMatchObject({ text: '[]', model: 'claude-opus-5-5', stop: 'end', usage: { inputTokens: 10, outputTokens: 3 }, fallbackUsed: false });
    const s = f.seen[0];
    expect(s?.url).toContain('https://api.anthropic.com/v1/messages');
    // SDK 1.x sends the API key as a Bearer token.
    expect(header(s, 'authorization')).toBe('Bearer sk-ant-x');
    expect(header(s, 'anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(s?.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1000, system: 'S', fallbacks: 'default', output_config: { effort: 'high' } });
    expect(s?.body).not.toHaveProperty('thinking');
  });

  it('does not ask Haiku 5.5 for server-side fallbacks', async () => {
    const f = fakeFetch({ json: { ...ok, model: 'claude-haiku-5-5' } });
    await createProvider({ id: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl: f.impl }).complete(REQ);
    expect(f.seen[0]?.body).not.toHaveProperty('fallbacks');
  });

  it('reports refusals and fallbacks', async () => {
    const refused = fakeFetch({ json: { ...ok, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } } });
    expect((await createProvider({ id: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', fetchImpl: refused.impl }).complete(REQ)).stop).toBe('refusal');
    const fell = fakeFetch({ json: { ...ok, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'fallback_message' }] } } });
    expect(await createProvider({ id: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', fetchImpl: fell.impl }).complete(REQ)).toMatchObject({ fallbackUsed: true, model: 'claude-opus-5' });
  });

  it('maps a bad key to an auth error without the key in the message', async () => {
    const f = fakeFetch({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const err = await createProvider({ id: 'anthropic', apiKey: 'sk-ant-SECRET', model: 'claude-opus-5-5', fetchImpl: f.impl, maxRetries: 0 }).complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
    expect(String(err)).not.toContain('sk-ant-SECRET');
  });
});

describe('OpenAI provider (Responses API)', () => {
  it('sends instructions, input, max_output_tokens and reasoning effort; reads output_text and usage', async () => {
    const f = fakeFetch({ json: { model: 'gpt-6.2-astra', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 5, output_tokens: 2 } } });
    const r = await createProvider({ id: 'openai', apiKey: 'sk-o', model: 'gpt-6.2-astra', fetchImpl: f.impl }).complete(REQ);
    expect(r).toMatchObject({ text: 'hi', stop: 'end', usage: { inputTokens: 5, outputTokens: 2 } });
    expect(f.seen[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(header(f.seen[0], 'authorization')).toBe('Bearer sk-o');
    expect(f.seen[0]?.body).toEqual({ model: 'gpt-6.2-astra', instructions: 'S', input: 'P', max_output_tokens: 1000, reasoning: { effort: 'high' }, store: false });
  });

  it('reports truncation and refusal', async () => {
    const cut = fakeFetch({ json: { model: 'm', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
    expect((await createProvider({ id: 'openai', apiKey: 'k', model: 'm', fetchImpl: cut.impl }).complete(REQ)).stop).toBe('max_tokens');
    const no = fakeFetch({ json: { model: 'm', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }], usage: { input_tokens: 1, output_tokens: 1 } } });
    expect((await createProvider({ id: 'openai', apiKey: 'k', model: 'm', fetchImpl: no.impl }).complete(REQ)).stop).toBe('refusal');
  });

  it('maps 429 to a retryable rate-limit error', async () => {
    const f = fakeFetch({ status: 429, json: { error: { message: 'slow down', type: 'rate_limit' } } });
    const err = (await createProvider({ id: 'openai', apiKey: 'k', model: 'm', fetchImpl: f.impl }).complete(REQ).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });
});

describe('Gemini provider (generateContent)', () => {
  it('puts the key in a header, not the URL, and skips thought parts', async () => {
    const f = fakeFetch({ json: { candidates: [{ content: { parts: [{ text: 'think', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 4 }, modelVersion: 'gemini-4-carbon' } });
    const r = await createProvider({ id: 'gemini', apiKey: 'AIza-x', model: 'gemini-4-carbon', fetchImpl: f.impl }).complete(REQ);
    expect(r).toMatchObject({ text: 'answer', stop: 'end', usage: { inputTokens: 7, outputTokens: 7 } });
    expect(f.seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:generateContent');
    expect(f.seen[0]?.url).not.toContain('key=');
    expect(header(f.seen[0], 'x-goog-api-key')).toBe('AIza-x');
    expect(f.seen[0]?.body).toEqual({
      systemInstruction: { parts: [{ text: 'S' }] },
      contents: [{ role: 'user', parts: [{ text: 'P' }] }],
      generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: 'HIGH' } },
    });
  });

  it('treats a blocked prompt or SAFETY stop as a refusal', async () => {
    const blocked = fakeFetch({ json: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 1 } } });
    expect((await createProvider({ id: 'gemini', apiKey: 'k', model: 'm', fetchImpl: blocked.impl }).complete(REQ)).stop).toBe('refusal');
  });

  it('rejects a model id that could alter the URL', () => {
    expect(() => createProvider({ id: 'gemini', apiKey: 'k', model: '../x?key=1', fetchImpl: fetch })).toThrow(/model/);
  });
});

describe('Ollama provider (local)', () => {
  it('calls localhost without a key, non-streaming, and reads content and counts', async () => {
    const f = fakeFetch({ json: { model: 'qwen3', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 2 } });
    const r = await createProvider({ id: 'ollama', model: 'qwen3', fetchImpl: f.impl }).complete(REQ);
    expect(r).toMatchObject({ text: 'ok', stop: 'end', usage: { inputTokens: 9, outputTokens: 2 } });
    expect(f.seen[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(header(f.seen[0], 'authorization')).toBeNull();
    expect(f.seen[0]?.body).toMatchObject({ model: 'qwen3', stream: false, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }], options: { num_predict: 1000 } });
  });

  it('uses a custom local address when given', async () => {
    const f = fakeFetch({ json: { message: { content: 'ok' }, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } });
    await createProvider({ id: 'ollama', model: 'qwen3', baseUrl: 'http://localhost:11500', fetchImpl: f.impl }).complete(REQ);
    expect(f.seen[0]?.url).toBe('http://localhost:11500/api/chat');
  });

  it('explains the likely cause when the browser blocks the request', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = (await createProvider({ id: 'ollama', model: 'qwen3', fetchImpl: failing }).complete(REQ).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/OLLAMA_ORIGINS/);
  });
});

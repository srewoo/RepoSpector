import { describe, expect, it } from 'vitest';
import { buildCatalog, cachedCatalog, CATALOG_TTL_MS, entryText, forgetCatalog, saveCatalog } from '../src/model-catalog.js';
import { resolveModel } from '../src/model-settings.js';
import { listModels } from '../src/providers/models.js';

type Reply = { status?: number; json: unknown };

function fake(replies: Reply[] | ((url: string) => Reply)) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    inits.push(init ?? {});
    const r = typeof replies === 'function' ? replies(u) : (replies[i++] ?? { json: {} });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, urls, inits };
}

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])),
    set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
  };
}

describe('listModels', () => {
  it('Anthropic: pages through /v1/models with the key in a header, browser-access header set', async () => {
    const f = fake([
      { json: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: true, last_id: 'claude-opus-5-5' } },
      { json: { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false } },
    ]);
    const m = await listModels('anthropic', { apiKey: 'sk-ant', fetchImpl: f.impl });
    expect(m).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ]);
    expect(f.urls[1]).toContain('after_id=claude-opus-5-5');
    const h = new Headers(f.inits[0]?.headers);
    expect(h.get('x-api-key')).toBe('sk-ant');
    expect(h.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(f.inits[0]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(f.urls[0]).not.toContain('sk-ant');
  });

  it('OpenAI: drops models that cannot review code, newest first', async () => {
    const f = fake([{ json: { data: [{ id: 'gpt-6-luna', created: 1 }, { id: 'text-embedding-4-large', created: 9 }, { id: 'gpt-6.2-sol', created: 5 }, { id: 'whisper-2', created: 8 }, { id: 'gpt-image-2', created: 7 }] } }]);
    expect((await listModels('openai', { apiKey: 'sk', fetchImpl: f.impl })).map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna']);
    expect(new Headers(f.inits[0]?.headers).get('authorization')).toBe('Bearer sk');
  });

  it('Gemini: only generateContent models, prefix stripped, key never in the URL', async () => {
    const f = fake([
      { json: { models: [{ name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' } },
      { json: { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] } },
    ]);
    const m = await listModels('gemini', { apiKey: 'AIza', fetchImpl: f.impl });
    expect(m).toEqual([
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
      { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite' },
    ]);
    expect(f.urls.join(' ')).not.toContain('AIza');
    expect(f.urls[1]).toContain('pageToken=p2');
  });

  it('Ollama: lists pulled models from the configured local address, no key needed', async () => {
    const f = fake([{ json: { models: [{ name: 'qwen3:32b' }, { name: 'llama3.3:70b-instruct-q4_K_M' }] } }]);
    expect((await listModels('ollama', { baseUrl: 'http://localhost:11500', fetchImpl: f.impl })).map((m) => m.id)).toEqual(['qwen3:32b', 'llama3.3:70b-instruct-q4_K_M']);
    expect(f.urls).toEqual(['http://localhost:11500/api/tags']);
  });

  it('drops unsafe and duplicate ids', async () => {
    const f = fake([{ json: { data: [{ id: 'ok-model' }, { id: '../evil' }, { id: 'a b' }, { id: 'ok-model' }] } }]);
    expect((await listModels('openai', { apiKey: 'sk', fetchImpl: f.impl })).map((m) => m.id)).toEqual(['ok-model']);
  });

  it('says a wrong key is wrong, per provider, and never repeats the key', async () => {
    const anthropic = fake([{ status: 401, json: { error: { message: 'invalid x-api-key' } } }]);
    await expect(listModels('anthropic', { apiKey: 'sk-secret', fetchImpl: anthropic.impl })).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/^Anthropic rejected this key \(401\)\. Check that you copied all of it/) });
    // OpenAI echoes part of the key in its message; the key itself must not come back.
    const openai = fake([{ status: 401, json: { error: { message: 'Incorrect API key provided: sk-secret-123.' } } }]);
    const err = await listModels('openai', { apiKey: 'sk-secret-123', fetchImpl: openai.impl }).catch((e: Error) => e);
    expect(err.message).toMatch(/OpenAI rejected this key/);
    expect(err.message).not.toContain('sk-secret-123');
    // Gemini answers an invalid key with 400, not 401.
    const gemini = fake([{ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } }]);
    await expect(listModels('gemini', { apiKey: 'AIza-bad', fetchImpl: gemini.impl })).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/Gemini rejected this key \(400\)/) });
  });

  it('tells a restricted key, a rate limit and an outage apart from a wrong key', async () => {
    const restricted = fake([{ status: 403, json: { error: { message: 'insufficient permissions: api.model.read' } } }]);
    await expect(listModels('openai', { apiKey: 'sk', fetchImpl: restricted.impl })).rejects.toThrow(/accepted the key but refused to list its models \(403\).*restricted/);
    const limited = fake([{ status: 429, json: {} }]);
    await expect(listModels('openai', { apiKey: 'sk', fetchImpl: limited.impl })).rejects.toMatchObject({ kind: 'rate_limit' });
    const down = fake([{ status: 503, json: {} }]);
    await expect(listModels('anthropic', { apiKey: 'sk', fetchImpl: down.impl })).rejects.toMatchObject({ kind: 'server' });
  });

  it('refuses to call without a key, and explains an unreachable Ollama', async () => {
    const none = fake([]);
    await expect(listModels('openai', { fetchImpl: none.impl })).rejects.toMatchObject({ kind: 'auth' });
    expect(none.urls).toEqual([]);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(listModels('ollama', { fetchImpl: offline })).rejects.toThrow(/Could not reach Ollama.*OLLAMA_ORIGINS/);
  });
});

describe('model catalog', () => {
  it('puts the key\'s recommended presets first with prices, then the rest in provider order; unknown prices stay unknown', () => {
    const c = buildCatalog('anthropic', [{ id: 'claude-x-preview', label: 'X' }, { id: 'claude-haiku-5-5', label: 'Haiku' }, { id: 'claude-sonnet-5-5', label: 'Sonnet' }, { id: 'claude-old', label: 'Old' }], 1);
    expect(c.entries.map((e) => e.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-x-preview', 'claude-old']);
    expect(c.entries[0]).toMatchObject({ recommended: 'balanced', price: { inPerM: 2, outPerM: 10 } });
    expect(c.entries[2]?.price).toBeUndefined();
    // Opus is a preset but this key cannot use it, so it is not offered.
    expect(c.entries.some((e) => e.id === 'claude-opus-5-5')).toBe(false);
  });

  it('caches per provider for a day, stores no key, and can forget one provider', async () => {
    const area = memoryArea();
    await saveCatalog(area, 'openai', [{ id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }], 1000);
    await saveCatalog(area, 'gemini', [{ id: 'gemini-4-hydrogen', label: 'G' }], 1000);
    expect((await cachedCatalog(area, 'openai', 1000 + CATALOG_TTL_MS))?.entries[0]).toMatchObject({ id: 'gpt-6.2-sol', recommended: 'balanced' });
    expect(await cachedCatalog(area, 'openai', 1001 + CATALOG_TTL_MS)).toBeNull();
    expect(JSON.stringify(area.data)).not.toMatch(/sk-|key/i);
    await forgetCatalog(area, 'openai');
    expect(await cachedCatalog(area, 'openai', 1000)).toBeNull();
    expect(await cachedCatalog(area, 'gemini', 1000)).not.toBeNull();
  });

  it('ignores a corrupted cache', async () => {
    const area = memoryArea();
    area.data.modelCatalog = { openai: { fetchedAt: 'x', models: [{ id: 1 }] } };
    expect(await cachedCatalog(area, 'openai', 0)).toBeNull();
  });

  it('describes an entry with its recommendation and price', () => {
    expect(entryText({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', recommended: 'best', price: { model: 'claude-opus-5-5', inPerM: 4, outPerM: 20 } })).toBe('Claude Opus 5.5 (claude-opus-5-5) · Recommended: best accuracy · $4 in / $20 out per M tokens');
    expect(entryText({ id: 'gpt-x', label: 'gpt-x' })).toBe('gpt-x');
  });

  it('a picked model that is a preset keeps its price in the cost estimate', () => {
    expect(resolveModel({ provider: 'anthropic', preset: 'balanced', customModel: 'claude-opus-5-5' }).prices).toMatchObject({ inPerM: 4, outPerM: 20 });
  });
});

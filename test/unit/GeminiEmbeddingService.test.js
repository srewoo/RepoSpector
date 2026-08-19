/**
 * Two properties here are easy to get wrong and silent when wrong:
 *
 *  - task type. Gemini retrieval embeddings are asymmetric, so a query embedded
 *    as a document degrades every search result without erroring.
 *  - vector/input alignment. A short response array would pair each vector with
 *    the wrong chunk, and search would confidently return the wrong file.
 */
const {
    GeminiEmbeddingService,
    GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_DIMENSION,
    TASK_TYPE,
} = require('../../src/services/GeminiEmbeddingService.js');

/** Build a fake embeddings response of `n` vectors of `dim` dimensions. */
function response(n, dim = GEMINI_EMBEDDING_DIMENSION, fill = 0.5) {
    return {
        embeddings: Array.from({ length: n }, () => ({
            values: Array.from({ length: dim }, () => fill),
        })),
    };
}

function mockFetch(impl) {
    global.fetch = jest.fn(impl);
    return global.fetch;
}

/** Body of the nth fetch call, parsed. */
const bodyOf = (call) => JSON.parse(call[1].body);

afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
});

describe('GeminiEmbeddingService — request shape', () => {
    it('posts to batchEmbedContents with the key in a header, not the URL', async () => {
        // A key in the query string leaks into logs and error traces.
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(1) }));
        const svc = new GeminiEmbeddingService({ apiKey: 'AIza-secret' });
        await svc.generateEmbeddings(['hello']);

        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toContain(`models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`);
        expect(url).not.toContain('AIza-secret');
        expect(init.headers['x-goog-api-key']).toBe('AIza-secret');
        expect(init.method).toBe('POST');
    });

    it('sends one request per text, with the configured dimension', async () => {
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(3) }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k' });
        await svc.generateEmbeddings(['a', 'b', 'c']);

        const body = bodyOf(global.fetch.mock.calls[0]);
        expect(body.requests).toHaveLength(3);
        expect(body.requests[0].content.parts[0].text).toBe('a');
        expect(body.requests[0].outputDimensionality).toBe(GEMINI_EMBEDDING_DIMENSION);
        expect(body.requests[0].model).toBe(`models/${GEMINI_EMBEDDING_MODEL}`);
    });

    it('defaults to the document task type', async () => {
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(1) }));
        await new GeminiEmbeddingService({ apiKey: 'k' }).generateEmbeddings(['doc']);
        expect(bodyOf(global.fetch.mock.calls[0]).requests[0].taskType)
            .toBe(TASK_TYPE.DOCUMENT);
    });

    it('uses the query task type when asked', async () => {
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(1) }));
        await new GeminiEmbeddingService({ apiKey: 'k' })
            .generateEmbeddings(['find me'], { taskType: TASK_TYPE.QUERY });
        expect(bodyOf(global.fetch.mock.calls[0]).requests[0].taskType)
            .toBe(TASK_TYPE.QUERY);
    });

    it('splits above the 100-request batch ceiling', async () => {
        mockFetch(async (_url, init) => ({
            ok: true, status: 200,
            json: async () => response(JSON.parse(init.body).requests.length),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k' });
        const out = await svc.generateEmbeddings(Array.from({ length: 250 }, (_, i) => `t${i}`));

        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(bodyOf(global.fetch.mock.calls[0]).requests).toHaveLength(100);
        expect(bodyOf(global.fetch.mock.calls[2]).requests).toHaveLength(50);
        expect(out).toHaveLength(250);
    });

    it('returns nothing for an empty input without calling the API', async () => {
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(0) }));
        expect(await new GeminiEmbeddingService({ apiKey: 'k' }).generateEmbeddings([])).toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('GeminiEmbeddingService — normalisation', () => {
    it('unit-normalises a truncated (Matryoshka) embedding', async () => {
        // gemini-embedding-001 is normalised only at its native 3072 dims; any
        // smaller outputDimensionality is a truncation Google says to normalise.
        mockFetch(async () => ({
            ok: true, status: 200,
            json: async () => ({ embeddings: [{ values: [3, 4] }] }),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', dimension: 2 });
        const [vec] = await svc.generateEmbeddings(['x']);

        expect(vec[0]).toBeCloseTo(0.6, 6);
        expect(vec[1]).toBeCloseTo(0.8, 6);
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        expect(norm).toBeCloseTo(1, 6);
    });

    it('leaves the native 3072-dim output untouched', async () => {
        const values = Array.from({ length: 3072 }, () => 0.5);
        mockFetch(async () => ({
            ok: true, status: 200, json: async () => ({ embeddings: [{ values }] }),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', dimension: 3072 });
        const [vec] = await svc.generateEmbeddings(['x']);
        expect(vec[0]).toBe(0.5);
    });

    it('does not divide by a zero norm', async () => {
        mockFetch(async () => ({
            ok: true, status: 200, json: async () => ({ embeddings: [{ values: [0, 0] }] }),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', dimension: 2 });
        const [vec] = await svc.generateEmbeddings(['x']);
        expect(vec.every(Number.isFinite)).toBe(true);
    });
});

describe('GeminiEmbeddingService — failure handling', () => {
    it('refuses to return misaligned vectors', async () => {
        // Two texts, one vector back: pairing them would attach every chunk to
        // the wrong embedding and search would return the wrong file.
        mockFetch(async () => ({ ok: true, status: 200, json: async () => response(1) }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', maxRetries: 1 });
        await expect(svc.generateEmbeddings(['a', 'b']))
            .rejects.toThrow(/1 embeddings for 2 inputs/);
    });

    it('rejects an empty embedding rather than storing it', async () => {
        mockFetch(async () => ({
            ok: true, status: 200, json: async () => ({ embeddings: [{ values: [] }] }),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', maxRetries: 1 });
        await expect(svc.generateEmbeddings(['a'])).rejects.toThrow(/empty embedding/);
    });

    it('fails fast on an auth error instead of backing off three times', async () => {
        mockFetch(async () => ({
            ok: false, status: 403,
            statusText: 'Forbidden',
            json: async () => ({ error: { message: 'API key not valid' } }),
        }));
        const svc = new GeminiEmbeddingService({ apiKey: 'bad' });
        await expect(svc.generateEmbeddings(['a'])).rejects.toThrow(/API key not valid/);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries a transient server error, then succeeds', async () => {
        let calls = 0;
        mockFetch(async () => {
            calls++;
            if (calls === 1) {
                return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => response(1) };
        });
        const svc = new GeminiEmbeddingService({ apiKey: 'k' });
        const out = await svc.generateEmbeddings(['a']);
        expect(out).toHaveLength(1);
        expect(calls).toBe(2);
    });

    it('gives up after maxRetries on a persistent server error', async () => {
        mockFetch(async () => ({ ok: false, status: 500, statusText: 'Boom', json: async () => ({}) }));
        const svc = new GeminiEmbeddingService({ apiKey: 'k', maxRetries: 2 });
        await expect(svc.generateEmbeddings(['a'])).rejects.toThrow(/500/);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('requires a key at init, before the indexing loop reads every file', async () => {
        await expect(new GeminiEmbeddingService({}).init())
            .rejects.toThrow(/Google API key is required/);
        await expect(new GeminiEmbeddingService({ apiKey: 'k' }).init()).resolves.toBe(true);
    });

    it('reports its model info for the UI', () => {
        const info = new GeminiEmbeddingService({ apiKey: 'k' }).getModelInfo();
        expect(info).toEqual({
            provider: 'gemini',
            model: GEMINI_EMBEDDING_MODEL,
            dimension: GEMINI_EMBEDDING_DIMENSION,
        });
    });
});

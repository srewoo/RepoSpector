/**
 * RAGService's provider routing. The service-level tests cover the Gemini API
 * contract; these cover the wiring around it, which is where a third provider
 * actually tends to break:
 *
 *  - the query/document distinction has to survive the trip from `retrieveContext`
 *    down to the request body, or every search silently embeds as a document;
 *  - the embedding cache is keyed on text alone, so without a task-type salt one
 *    string embedded both ways collides and search gets a document vector.
 */
const { RAGService } = require('../../src/services/RAGService.js');

const vec = (dim = 1536, fill = 0.1) => Array.from({ length: dim }, () => fill);

function mockGemini() {
    global.fetch = jest.fn(async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => ({
            embeddings: JSON.parse(init.body).requests.map(() => ({ values: vec() })),
        }),
    }));
    return global.fetch;
}

const bodyOf = (call) => JSON.parse(call[1].body);

afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
});

describe('RAGService — gemini provider', () => {
    it('selects the Gemini service and reports its dimensions', () => {
        const svc = new RAGService({ provider: 'gemini', apiKey: 'AIza-k' });
        expect(svc.provider).toBe('gemini');
        expect(svc.getProviderInfo()).toEqual({
            provider: 'gemini',
            model: 'gemini-embedding-001',
            dimension: 1536,
        });
    });

    it('passes the Google key through to the request header', async () => {
        mockGemini();
        const svc = new RAGService({ provider: 'gemini', apiKey: 'AIza-k' });
        await svc.generateEmbeddings(['x']);
        expect(global.fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('AIza-k');
    });

    it('embeds indexing text as a document and search text as a query', async () => {
        mockGemini();
        const svc = new RAGService({ provider: 'gemini', apiKey: 'k' });

        await svc.generateEmbeddings(['a chunk of code']);
        expect(bodyOf(global.fetch.mock.calls[0]).requests[0].taskType)
            .toBe('RETRIEVAL_DOCUMENT');

        await svc.generateEmbeddings(['where is auth handled'], { isQuery: true });
        expect(bodyOf(global.fetch.mock.calls[1]).requests[0].taskType)
            .toBe('RETRIEVAL_QUERY');
    });

    it('does not serve a document vector to a query for the same string', async () => {
        // The cache is keyed on text; without a task-type salt the document
        // embedding of "auth" would be returned for a query for "auth".
        mockGemini();
        const svc = new RAGService({ provider: 'gemini', apiKey: 'k' });

        await svc.generateEmbeddings(['auth']);
        await svc.generateEmbeddings(['auth'], { isQuery: true });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(bodyOf(global.fetch.mock.calls[1]).requests[0].taskType)
            .toBe('RETRIEVAL_QUERY');
    });

    it('still caches a repeated identical query', async () => {
        mockGemini();
        const svc = new RAGService({ provider: 'gemini', apiKey: 'k' });
        await svc.generateEmbeddings(['auth'], { isQuery: true });
        await svc.generateEmbeddings(['auth'], { isQuery: true });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces a missing key at init rather than mid-index', async () => {
        const svc = new RAGService({ provider: 'gemini', apiKey: null });
        svc.vectorStore.init = jest.fn(async () => {});
        await expect(svc.init()).rejects.toThrow(/Google API key is required/);
    });

    it('leaves the local and openai providers unchanged', () => {
        expect(new RAGService({}).provider).toBe('local');
        expect(new RAGService({ provider: 'openai', apiKey: 'sk' }).getProviderInfo())
            .toEqual({ provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 });
    });
});

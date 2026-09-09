/**
 * Query routing: expansion must feed only the keyword (BM25) side, with
 * original casing preserved so BM25's camelCase split still matches
 * identifiers; the embedder must see the plain question, since synonyms
 * dilute the vector.
 */
const { RAGService } = require('../../src/services/RAGService.js');

describe('retrieveContext query routing', () => {
    it('embeds the plain question and gives BM25 the cased original plus expansions', async () => {
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.1, 0.2]], getDimension: () => 2 };
        const svc = new RAGService({ provider: 'local', embeddingService: fake });
        svc.init = async () => {};

        const seen = {};
        svc.generateEmbeddings = jest.fn(async (texts) => { seen.embedded = texts[0]; return [[0.1, 0.2]]; });
        svc.hybridSearcher = { search: jest.fn(async (q) => { seen.keyword = q; return []; }) };
        svc.vectorStore = { getRepoStats: async () => ({ chunkCount: 1 }) };

        // NOTE: the brief's own example query "where is handleUpload defined"
        // produces an EMPTY `expansions` array (queryExpander only pushes to
        // `expansions` from its abbreviation/synonym token loop; the "where is"
        // context handler only feeds `addTerms`, which this fix intentionally
        // does not consult per the brief's Interfaces section). That query
        // would pass this test vacuously without exercising the expansion
        // path. "how to fn handleUpload" hits the abbreviation loop (fn ->
        // function) while still containing a camelCase identifier.
        await svc.retrieveContext('o/r', 'how to fn handleUpload', 5, { useHybridSearch: true, useQueryExpansion: true });

        expect(seen.embedded).toBe('how to fn handleUpload');
        expect(seen.keyword).toMatch(/handleUpload/);      // case preserved
        expect(seen.keyword).toMatch(/\bfunction\b/);      // the mapped expansion ('fn' -> 'function') actually reached BM25
        expect(seen.keyword.length).toBeGreaterThan('how to fn handleUpload'.length); // expansions appended
    });
});

/**
 * `keywordQuery` is consumed ONLY inside the hybrid branch, so with hybrid
 * search off the expansion was computed, logged as "Query expanded for keyword
 * search", and thrown away — a config flag that silently did nothing, which is
 * the exact defect class this work exists to remove.
 */
describe('useQueryExpansion is honest when hybrid search is off', () => {
    const makeSvc = () => {
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.1, 0.2]], getDimension: () => 2 };
        const svc = new RAGService({ provider: 'local', embeddingService: fake });
        svc.init = async () => {};
        svc.vectorStore = {
            getRepoStats: async () => ({ chunkCount: 1 }),
            search: jest.fn(async () => []),
        };
        return svc;
    };

    it('does not compute or announce an expansion it cannot use', async () => {
        const svc = makeSvc();
        const embedded = [];
        svc.generateEmbeddings = jest.fn(async (texts) => { embedded.push(texts[0]); return [[0.1, 0.2]]; });
        // test/setup.js already replaces console.log with a jest.fn, so spyOn
        // hands back a mock that has the WHOLE file's prior calls on it.
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        logSpy.mockClear();

        await svc.retrieveContext('o/r', 'how to fn handleUpload', 5, {
            useHybridSearch: false, useQueryExpansion: true,
        });

        expect(embedded).toEqual(['how to fn handleUpload']);
        expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/Query expanded for keyword search/);
        logSpy.mockRestore();
    });

    it('vector-only search still embeds the plain question', async () => {
        const svc = makeSvc();
        const embedded = [];
        svc.generateEmbeddings = jest.fn(async (texts) => { embedded.push(texts[0]); return [[0.1, 0.2]]; });
        await svc.retrieveContext('o/r', 'how to fn handleUpload', 5, {
            useHybridSearch: false, useQueryExpansion: false,
        });
        expect(embedded).toEqual(['how to fn handleUpload']);
    });
});

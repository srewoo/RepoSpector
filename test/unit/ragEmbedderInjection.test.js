/**
 * RAGService hard-constructed OffscreenEmbeddingService, which messages a
 * Chrome offscreen document that does not exist outside the extension. The
 * injection point is what lets the same RAG pipeline run in Node. Additive by
 * construction: with no override, behaviour is exactly as before.
 */
const { RAGService } = require('../../src/services/RAGService.js');

describe('RAGService embedding-service injection', () => {
    test('uses an injected embedding service when one is provided', () => {
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.1]], getDimension: () => 1 };
        const rag = new RAGService({ provider: 'local', embeddingService: fake });
        expect(rag.embeddingService).toBe(fake);
    });

    test('with no override, it still constructs its own service as before', () => {
        const rag = new RAGService({ provider: 'local' });
        expect(rag.embeddingService).toBeTruthy();
        expect(rag.embeddingService.constructor.name).toBe('OffscreenEmbeddingService');
    });

    test('an injected service is honoured for non-local providers too', () => {
        // Otherwise the override would silently do nothing on a provider switch.
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.2]], getDimension: () => 1 };
        const rag = new RAGService({ provider: 'gemini', apiKey: 'k', embeddingService: fake });
        expect(rag.embeddingService).toBe(fake);
    });
});

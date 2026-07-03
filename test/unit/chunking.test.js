/**
 * Tests for the REAL CodeChunker (src/utils/chunking.js) — no mocks.
 * Previously this suite jest.mock'd the subject and tested inline fakes with
 * method names ('chunkCode', 'findNaturalBoundary', 'addOverlapContext') that
 * do not exist in production.
 */

const { CodeChunker } = require('../../src/utils/chunking.js');

describe('CodeChunker', () => {
    let chunker;
    beforeEach(() => {
        chunker = new CodeChunker();
    });

    describe('estimateTokens', () => {
        it('should estimate ~1 token per 4 characters', () => {
            expect(chunker.estimateTokens('')).toBe(0);
            expect(chunker.estimateTokens('a'.repeat(400))).toBe(100);
        });
    });

    describe('getMaxTokensForModel / getChunkSize', () => {
        it('should return known model limits and fall back to default', () => {
            expect(chunker.getMaxTokensForModel('gpt-4.1')).toBe(128000);
            expect(chunker.getMaxTokensForModel('embedding')).toBe(1500);
            expect(chunker.getMaxTokensForModel('nonexistent-model')).toBe(chunker.modelLimits.default);
        });

        it('should compute a positive chunk size in characters', () => {
            const size = chunker.getChunkSize('gpt-4.1');
            expect(size).toBeGreaterThan(0);
            // embedding reserves no tokens, so its char size should be smaller
            expect(chunker.getChunkSize('embedding')).toBeLessThan(size);
        });
    });

    describe('createSemanticChunks', () => {
        it('should return an empty array for empty or whitespace code', () => {
            expect(chunker.createSemanticChunks('', 'gpt-4.1')).toEqual([]);
            expect(chunker.createSemanticChunks('   \n  ', 'gpt-4.1')).toEqual([]);
        });

        it('should return a single chunk for small code', () => {
            const code = 'function add(a, b) {\n  return a + b;\n}\n';
            const chunks = chunker.createSemanticChunks(code, 'gpt-4.1');
            expect(chunks.length).toBe(1);
            expect(chunks[0]).toMatchObject({ type: 'code' });
            expect(chunks[0].content).toContain('function add');
            expect(chunks[0].tokens).toBeGreaterThan(0);
        });

        it('should split large code into multiple chunks under a small model budget', () => {
            // Build many small functions so the estimated token count comfortably
            // exceeds the embedding model's small chunk budget, forcing a split.
            const count = 1500;
            const fns = Array.from({ length: count }, (_, i) =>
                `function fn${i}(x) {\n  return x + ${i};\n}\n`).join('\n');
            const chunks = chunker.createSemanticChunks(fns, 'embedding');
            expect(chunks.length).toBeGreaterThan(1);
            // Reassembled content should still contain first and last functions.
            const joined = chunks.map(c => c.content).join('');
            expect(joined).toContain('function fn0');
            expect(joined).toContain(`function fn${count - 1}`);
        });

        it('should still produce a chunk for code with no detectable boundaries', () => {
            const blob = 'x'.repeat(200);
            const chunks = chunker.createSemanticChunks(blob, 'gpt-4.1');
            expect(chunks.length).toBeGreaterThanOrEqual(1);
            expect(chunks[0].content.length).toBeGreaterThan(0);
        });
    });

    describe('findCodeBoundaries', () => {
        it('should find function/class boundaries in JS code', () => {
            const code = 'function a() {}\nclass B {}\nconst c = function() {};\n';
            const boundaries = chunker.findCodeBoundaries(code);
            expect(Array.isArray(boundaries)).toBe(true);
            expect(boundaries.length).toBeGreaterThan(0);
        });
    });
});

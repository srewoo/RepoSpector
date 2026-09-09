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

describe('chunk budget and monotonic boundaries', () => {
    const { CodeChunker } = require('../../src/utils/chunking.js');
    const chunker = new CodeChunker();
    const budgetChars = chunker.getChunkSize('embedding');

    it('never emits a chunk larger than the budget plus overlap', () => {
        const prose = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(450); // ~25 KB, no code boundaries
        const chunks = chunker.createSemanticChunks(prose, 'embedding');
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(budgetChars + chunker.calculateOverlapChars());
    });

    it('does not duplicate content when lines repeat', () => {
        const json = '{\n' + Array.from({ length: 4000 }, (_, i) => `  "k${i}": {\n    "a": 1\n  },`).join('\n') + '\n}\n';
        const chunks = chunker.createSemanticChunks(json, 'embedding');
        const total = chunks.reduce((n, c) => n + c.content.length, 0);
        expect(total).toBeLessThanOrEqual(json.length * 1.3);
    });
});

/**
 * splitOversized is the ONLY path that fires for files with no detectable code
 * boundaries — JSON, prose, minified bundles. It used to emit hard, overlap-free
 * cuts while the accumulate path overlapped, so a defect spanning a cut lost its
 * surrounding context on both sides.
 */
describe('splitOversized overlaps its pieces like the accumulate path', () => {
    const { CodeChunker } = require('../../src/utils/chunking.js');
    const chunker = new CodeChunker();
    const budgetChars = chunker.getChunkSize('embedding');
    const overlapChars = Math.min(chunker.calculateOverlapChars(), Math.floor(budgetChars / 2));

    const prose = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(450);
    const jsonish = '{\n' + Array.from({ length: 4000 }, (_, i) => `  "k${i}": {\n    "a": 1\n  },`).join('\n') + '\n}\n';

    // Two chunks are in the same splitOversized run iff the later one starts
    // before the earlier one ended. A pair where startIndex === prev.endIndex is
    // a SEGMENT junction (the giant-segment branch flushes and restarts at the
    // boundary), which has never overlapped and is not what this fix is about.
    const sameRun = (prev, cur) => cur.startIndex < prev.endIndex;

    it('prose with no newlines at all overlaps every consecutive pair', () => {
        const chunks = chunker.createSemanticChunks(prose, 'embedding');
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 1; i < chunks.length; i++) {
            expect(sameRun(chunks[i - 1], chunks[i])).toBe(true);
            const prev = chunks[i - 1].content;
            const shared = Math.min(overlapChars, prev.length, chunks[i].content.length);
            expect(shared).toBeGreaterThan(0);
            expect(chunks[i].content.startsWith(prev.slice(prev.length - shared))).toBe(true);
        }
    });

    it('repeated-line JSON overlaps within each run, and only junctions do not', () => {
        const chunks = chunker.createSemanticChunks(jsonish, 'embedding');
        expect(chunks.length).toBeGreaterThan(1);
        let overlapped = 0;
        for (let i = 1; i < chunks.length; i++) {
            if (!sameRun(chunks[i - 1], chunks[i])) {
                expect(chunks[i].startIndex).toBe(chunks[i - 1].endIndex);
                continue;
            }
            const prev = chunks[i - 1].content;
            const shared = Math.min(overlapChars, prev.length, chunks[i].content.length);
            expect(chunks[i].content.startsWith(prev.slice(prev.length - shared))).toBe(true);
            overlapped++;
        }
        // The vast majority of cuts are inside a run, not at a junction.
        expect(overlapped).toBeGreaterThan((chunks.length - 1) * 0.7);
    });

    it.each([['prose', prose], ['JSON', jsonish]])(
        '%s: every chunk is non-empty, within budget, and startIndex advances', (_label, text) => {
            const chunks = chunker.createSemanticChunks(text, 'embedding');
            for (let i = 0; i < chunks.length; i++) {
                expect(chunks[i].content.length).toBeGreaterThan(0);
                // +1 is the pre-existing `lastIndexOf('\n', end)` off-by-one
                // (nl can equal `end`, so `nl + 1` overshoots by one char). It
                // is a deferred minor, explicitly out of scope for this wave.
                expect(chunks[i].content.length).toBeLessThanOrEqual(budgetChars + 1);
                if (i > 0) expect(chunks[i].startIndex).toBeGreaterThan(chunks[i - 1].startIndex);
            }
        },
    );

    it('terminates on a single line far longer than the whole budget', () => {
        const oneLine = 'x'.repeat(budgetChars * 5);
        const chunks = chunker.createSemanticChunks(oneLine, 'embedding');
        expect(chunks.length).toBeGreaterThan(1);
        // A finite result at all is the assertion: pos must strictly advance.
        expect(chunks.length).toBeLessThan(20);
        expect(chunks.every(c => c.content.length > 0)).toBe(true);
    });

    it('covers the whole input from first character to last', () => {
        const chunks = chunker.createSemanticChunks(prose, 'embedding');
        expect(chunks[0].startIndex).toBe(0);
        expect(chunks[chunks.length - 1].endIndex).toBe(prose.length);
    });
});

const {
    DEFAULT_BUDGET,
    LEGACY_BUDGET,
    resolveBudget,
} = require('../../src/utils/reviewContextBudget.js');
const { buildPerFileReviewPrompt } = require('../../src/utils/multiPassPrompts.js');
const { flattenContent } = require('../../src/utils/promptCache.js');

describe('resolveBudget', () => {
    it('returns the raised defaults with no arguments', () => {
        expect(resolveBudget()).toEqual(DEFAULT_BUDGET);
    });

    it('returns the pre-change values under the legacy profile', () => {
        // This profile is the eval A/B baseline; if it drifts, the comparison
        // stops measuring the change that was actually made.
        expect(resolveBudget({ profile: 'legacy' })).toEqual(LEGACY_BUDGET);
        expect(LEGACY_BUDGET.ragChunks).toBe(3);
        expect(LEGACY_BUDGET.ragChunkChars).toBe(600);
        expect(LEGACY_BUDGET.graphContextChars).toBe(4000);
    });

    it('falls back to defaults for an unknown profile', () => {
        expect(resolveBudget({ profile: 'nonsense' })).toEqual(DEFAULT_BUDGET);
    });

    it('lets settings override individual keys', () => {
        const out = resolveBudget({ settings: { ragChunks: 20 } });
        expect(out.ragChunks).toBe(20);
        expect(out.ragChunkChars).toBe(DEFAULT_BUDGET.ragChunkChars);
    });

    it('lets per-call overrides beat settings', () => {
        const out = resolveBudget({
            settings: { ragChunks: 20 },
            overrides: { ragChunks: 5 },
        });
        expect(out.ragChunks).toBe(5);
    });

    it('ignores unknown keys rather than merging them', () => {
        // A typo that silently created a budget nobody reads would be invisible.
        const out = resolveBudget({ settings: { ragChunkz: 99 } });
        expect(out.ragChunkz).toBeUndefined();
        expect(out).toEqual(DEFAULT_BUDGET);
    });

    it('rejects values that would silently disable a context channel', () => {
        const out = resolveBudget({
            settings: { ragChunks: -1, graphContextChars: NaN, maxFullFiles: 'lots' },
        });
        expect(out.ragChunks).toBe(DEFAULT_BUDGET.ragChunks);
        expect(out.graphContextChars).toBe(DEFAULT_BUDGET.graphContextChars);
        expect(out.maxFullFiles).toBe(DEFAULT_BUDGET.maxFullFiles);
    });

    it('accepts an explicit zero, which is a real choice', () => {
        expect(resolveBudget({ overrides: { ragChunks: 0 } }).ragChunks).toBe(0);
    });

    it('raises every token budget above legacy, and network-bound ones least', () => {
        for (const key of ['ragChunks', 'ragChunkChars', 'graphContextChars', 'graphMaxFiles']) {
            expect(DEFAULT_BUDGET[key]).toBeGreaterThan(LEGACY_BUDGET[key]);
        }
        // maxFullFiles is paid in API round trips on the critical path, not
        // tokens, so it moves proportionally less than the token budgets.
        const fileRatio = DEFAULT_BUDGET.maxFullFiles / LEGACY_BUDGET.maxFullFiles;
        const chunkRatio = DEFAULT_BUDGET.ragChunkChars / LEGACY_BUDGET.ragChunkChars;
        expect(fileRatio).toBeLessThan(chunkRatio);
    });
});

describe('budgets reaching the prompt', () => {
    const chunk = (i) => ({ filePath: `src/f${i}.js`, content: 'z'.repeat(5000) });
    const unit = {
        files: [{ filename: 'src/a.js', language: 'javascript', status: 'modified', patch: '@@ -1 +1 @@\n+x' }],
    };
    const render = (contextBudget, extra = {}) => flattenContent(buildPerFileReviewPrompt(unit, {
        prContext: { title: 't' },
        ragChunks: Array.from({ length: 12 }, (_, i) => chunk(i)),
        graphContext: 'G'.repeat(20000),
        contextBudget,
        ...extra,
    }));

    it('emits more RAG chunks under the default budget than under legacy', () => {
        const count = (text) => (text.match(/^\/\/ src\/f\d+\.js$/gm) || []).length;
        expect(count(render(null))).toBe(DEFAULT_BUDGET.ragChunks);
        expect(count(render(LEGACY_BUDGET))).toBe(LEGACY_BUDGET.ragChunks);
    });

    it('keeps more of each chunk under the default budget', () => {
        expect(render(null)).toContain('z'.repeat(DEFAULT_BUDGET.ragChunkChars));
        expect(render(LEGACY_BUDGET)).not.toContain('z'.repeat(DEFAULT_BUDGET.ragChunkChars));
    });

    it('keeps more graph context under the default budget', () => {
        expect(render(null)).toContain('G'.repeat(DEFAULT_BUDGET.graphContextChars));
        expect(render(LEGACY_BUDGET)).toContain('G'.repeat(LEGACY_BUDGET.graphContextChars));
        expect(render(LEGACY_BUDGET)).not.toContain('G'.repeat(LEGACY_BUDGET.graphContextChars + 1));
    });

    it('honours a zero budget by omitting the channel entirely', () => {
        const text = render({ ragChunks: 0, graphContextChars: 0 });
        expect(text).not.toContain('// src/f0.js');
    });
});

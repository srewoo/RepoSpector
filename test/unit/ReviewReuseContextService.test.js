/**
 * The reuse lens is the one finding class no diff-only reviewer can produce, and
 * also the one where a wrong answer is most expensive: telling an author they
 * reimplemented something they did not costs the reviewer credibility for every
 * other finding. So these tests pin the filters that keep it honest — above all
 * that a hit inside the PR's own files is never offered as prior art.
 */
const {
    ReviewReuseContextService,
    REUSE_DEFAULTS,
} = require('../../src/services/ReviewReuseContextService.js');

/** A RAG double returning a fixed hit list, recording the queries it saw. */
function fakeRag(hits) {
    const queries = [];
    return {
        queries,
        retrieveContext: jest.fn(async (repoId, query) => {
            queries.push(query);
            return typeof hits === 'function' ? hits(query) : hits;
        }),
    };
}

const prWithNewFunction = {
    files: [{
        filename: 'src/checkout/total.js',
        patch: [
            '@@ -1,2 +1,6 @@',
            '+export function calculateOrderTotal(items, taxRate) {',
            '+    return items.reduce((s, i) => s + i.price, 0) * (1 + taxRate);',
            '+}',
        ].join('\n'),
    }],
};

describe('ReviewReuseContextService — availability', () => {
    it('is unavailable without a RAG service, and never throws', async () => {
        const res = await new ReviewReuseContextService({}).buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
        expect(res.context).toBe('');
        expect(res.stats.skipped).toBe('no-rag-service');
    });

    it('is unavailable without a repoId', async () => {
        const svc = new ReviewReuseContextService({ ragService: fakeRag([]) });
        const res = await svc.buildForReview(prWithNewFunction, '');
        expect(res.stats.skipped).toBe('no-repo-id');
    });

    it('is unavailable when the diff declares nothing', async () => {
        const rag = fakeRag([]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(
            { files: [{ filename: 'README.md', patch: '@@ -1 +1,2 @@\n+some prose' }] },
            'repo',
        );
        expect(res.available).toBe(false);
        expect(res.stats.skipped).toBe('no-new-declarations');
        expect(rag.retrieveContext).not.toHaveBeenCalled();
    });

    it('is unavailable when retrieval finds no prior art', async () => {
        const svc = new ReviewReuseContextService({ ragService: fakeRag([]) });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
        expect(res.stats.skipped).toBe('no-prior-art');
        expect(res.stats.symbolsProbed).toBeGreaterThan(0);
    });

    it('survives a retrieval failure without failing the review', async () => {
        const rag = { retrieveContext: jest.fn(async () => { throw new Error('not indexed'); }) };
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
        expect(res.context).toBe('');
    });
});

describe('ReviewReuseContextService — what counts as prior art', () => {
    it('surfaces a similar existing implementation with its path and code', async () => {
        const rag = fakeRag([{
            filePath: 'src/billing/totals.js',
            content: 'export function computeTotal(lines, tax) { /* ... */ }',
            relevanceScore: 0.82,
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');

        expect(res.available).toBe(true);
        expect(res.context).toContain('calculateOrderTotal');
        expect(res.context).toContain('src/billing/totals.js');
        expect(res.context).toContain('computeTotal');
        expect(res.stats.hits).toBe(1);
    });

    it('drops hits inside the PR’s own files', async () => {
        // The index holds the pre-change repo, so a MODIFIED function’s old body
        // is the closest match to itself. Reporting that would make every edit
        // look like a reimplementation of the thing being edited.
        const rag = fakeRag([{
            filePath: 'src/checkout/total.js',
            content: 'export function calculateOrderTotal(items) { /* old body */ }',
            relevanceScore: 0.99,
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
        expect(res.stats.skipped).toBe('no-prior-art');
    });

    it('drops a changed file that the index reports under a different root', async () => {
        const rag = fakeRag([{
            filePath: 'packages/web/src/checkout/total.js',
            content: 'function calculateOrderTotal() {}',
            relevanceScore: 0.9,
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
    });

    it('drops test files, where parallel helpers are normal', async () => {
        const rag = fakeRag([{
            filePath: 'test/billing/totals.test.js',
            content: 'function calculateOrderTotal() {}',
            relevanceScore: 0.9,
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
    });

    it('drops weak matches, because a weak match yields a wrong claim not a weak one', async () => {
        const rag = fakeRag([{
            filePath: 'src/unrelated/thing.js',
            content: 'function somethingElse() {}',
            relevanceScore: 0.31, // above RAG's default floor, below this lens's
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.available).toBe(false);
        expect(REUSE_DEFAULTS.minScore).toBeGreaterThan(0.3);
    });

    it('keeps one candidate per file, not one per chunk', async () => {
        const rag = fakeRag([
            { filePath: 'src/billing/totals.js', content: 'chunk one', relevanceScore: 0.9 },
            { filePath: 'src/billing/totals.js', content: 'chunk two', relevanceScore: 0.88 },
            { filePath: 'src/billing/other.js', content: 'chunk three', relevanceScore: 0.8 },
        ]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.context).toContain('chunk one');
        expect(res.context).not.toContain('chunk two');
        expect(res.context).toContain('chunk three');
    });
});

describe('ReviewReuseContextService — query construction and budget', () => {
    it('queries with the declaration line, not just the bare symbol name', async () => {
        // `save` alone matches half a codebase; the parameters make it selective.
        const rag = fakeRag([]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        await svc.buildForReview(prWithNewFunction, 'repo');

        expect(rag.queries.length).toBeGreaterThan(0);
        const q = rag.queries.find(x => x.includes('calculateOrderTotal'));
        expect(q).toContain('items, taxRate');
    });

    it('caps probes per file and in total', async () => {
        const manySymbols = Array.from({ length: 12 }, (_, i) =>
            `+export function generatedHelperNumber${i}(a, b) { return a + b; }`).join('\n');
        const rag = fakeRag([]);
        const svc = new ReviewReuseContextService({ ragService: rag });

        await svc.buildForReview(
            { files: [{ filename: 'src/gen.js', patch: `@@ -1 +1,12 @@\n${manySymbols}` }] },
            'repo',
        );
        expect(rag.retrieveContext.mock.calls.length)
            .toBeLessThanOrEqual(REUSE_DEFAULTS.maxSymbolsPerFile);
    });

    it('spreads the global cap across files instead of letting one consume it', async () => {
        const files = Array.from({ length: 8 }, (_, i) => ({
            filename: `src/mod${i}.js`,
            patch: `@@ -1 +1,3 @@\n+export function distinctHandlerName${i}(payload) { return payload; }`,
        }));
        const rag = fakeRag([]);
        const svc = new ReviewReuseContextService({ ragService: rag });

        await svc.buildForReview({ files }, 'repo');
        expect(rag.retrieveContext.mock.calls.length)
            .toBeLessThanOrEqual(REUSE_DEFAULTS.maxSymbolsTotal);
        // Files beyond the first got a look in.
        expect(new Set(rag.queries.map(q => q.match(/distinctHandlerName(\d)/)?.[1])).size)
            .toBeGreaterThan(1);
    });

    it('frames candidates as candidates, not as confirmed duplication', async () => {
        const rag = fakeRag([{
            filePath: 'src/billing/totals.js', content: 'x', relevanceScore: 0.9,
        }]);
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview(prWithNewFunction, 'repo');
        expect(res.context).toMatch(/CANDIDATES, not confirmed/i);
    });

    it('bounds the rendered block', async () => {
        const huge = 'x'.repeat(5000);
        const rag = fakeRag([
            { filePath: 'src/a.js', content: huge, relevanceScore: 0.9 },
            { filePath: 'src/b.js', content: huge, relevanceScore: 0.9 },
        ]);
        const files = Array.from({ length: 6 }, (_, i) => ({
            filename: `src/mod${i}.js`,
            patch: `@@ -1 +1,3 @@\n+export function uniqueThing${i}(a) { return a; }`,
        }));
        const svc = new ReviewReuseContextService({ ragService: rag });
        const res = await svc.buildForReview({ files }, 'repo');

        expect(res.context.length).toBeLessThan(REUSE_DEFAULTS.maxContextChars + 500);
        // Snippets are individually clipped too.
        expect(res.context).not.toContain(huge);
    });
});

const { ReviewGraphContextService } = require('../../src/services/ReviewGraphContextService.js');

/**
 * Minimal CodeGraphPipeline stand-in. The real one is backed by IndexedDB and
 * tree-sitter; these tests are about WHICH questions the review service asks the
 * graph, which is where the value (and the previous gap) lives.
 */
function makePipeline(overrides = {}) {
    return {
        graph: {
            nodeCount: 42,
            findNodeByName: jest.fn(() => [{ id: 'n1', properties: { name: 'processPayment', filePath: 'src/pay.js' } }]),
            getRelationshipsTo: jest.fn(() => [
                { type: 'CALLS', sourceId: 'c1' },
                { type: 'CALLS', sourceId: 'c2' },
            ]),
            getNode: jest.fn((id) => ({
                c1: { properties: { name: 'checkout', filePath: 'src/checkout.js' } },
                c2: { properties: { name: 'refund', filePath: 'src/refund.js' } },
            }[id])),
        },
        hasGraph: jest.fn(async () => true),
        loadGraph: jest.fn(async () => { }),
        getSymbolContext: jest.fn((s) => `## Symbol: \`${s}\`\n**Called by** (2)`),
        getContextForQuestion: jest.fn(() => '## generic neighbourhood'),
        safetyCheck: jest.fn(() => ({ level: 'high', reason: 'widely called', affectedCount: 12 })),
        getUntestedInBlastRadius: jest.fn(() => [
            { name: 'refund', filePath: 'src/refund.js' },
        ]),
        ...overrides,
    };
}

const prWith = (patch, filename = 'src/pay.js') => ({ files: [{ filename, patch }] });

const PATCH = [
    '@@ -1,2 +1,6 @@',
    ' const x = 1;',
    '+function processPayment(order) {',
    '+  return charge(order);',
    '+}',
].join('\n');

describe('ReviewGraphContextService', () => {
    it('returns empty when no graph is available', async () => {
        const svc = new ReviewGraphContextService({
            codeGraphPipeline: makePipeline({ graph: { nodeCount: 0 }, hasGraph: jest.fn(async () => false) }),
        });
        const out = await svc.buildForReview(prWith(PATCH), 'repo');
        expect(out.available).toBe(false);
        expect(out.combined).toBe('');
    });

    it('returns empty when no pipeline is wired at all', async () => {
        const svc = new ReviewGraphContextService({});
        expect((await svc.buildForReview(prWith(PATCH), 'repo')).available).toBe(false);
    });

    it('asks the graph about symbols DECLARED in the diff, not every identifier', async () => {
        const pipeline = makePipeline();
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });
        await svc.buildForReview(prWith(PATCH), 'repo');

        expect(pipeline.getSymbolContext).toHaveBeenCalledWith('processPayment');
        // `charge` is called, not declared — it must not trigger a lookup.
        expect(pipeline.getSymbolContext).not.toHaveBeenCalledWith('charge');
    });

    it('includes callers, safety and untested blast radius for a changed symbol', async () => {
        const svc = new ReviewGraphContextService({ codeGraphPipeline: makePipeline() });
        const out = await svc.buildForReview(prWith(PATCH), 'repo');

        expect(out.available).toBe(true);
        const ctx = out.byFile['src/pay.js'];
        expect(ctx).toContain('Called by');
        expect(ctx).toContain('Change safety');
        expect(ctx).toContain('widely called');
        expect(ctx).toContain('Untested code in the blast radius');
    });

    it('warns about consumer files that live outside the PR', async () => {
        // The highest-value cross-file signal: you changed a contract and did not
        // update its callers — invisible in a diff.
        const svc = new ReviewGraphContextService({ codeGraphPipeline: makePipeline() });
        const out = await svc.buildForReview(prWith(PATCH), 'repo');

        expect(out.externalImpact).toEqual(expect.arrayContaining(['src/checkout.js', 'src/refund.js']));
        expect(out.combined).toContain('Files outside this PR that depend on the changed symbols');
    });

    it('excludes files that ARE in the PR from the external impact list', async () => {
        const pipeline = makePipeline({
            graph: {
                nodeCount: 42,
                findNodeByName: jest.fn(() => [{ id: 'n1', properties: { name: 'processPayment' } }]),
                getRelationshipsTo: jest.fn(() => [{ type: 'CALLS', sourceId: 'c1' }]),
                getNode: jest.fn(() => ({ properties: { name: 'self', filePath: 'src/pay.js' } })),
            },
            getUntestedInBlastRadius: jest.fn(() => []),
        });
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });
        const out = await svc.buildForReview(prWith(PATCH), 'repo');
        expect(out.externalImpact).not.toContain('src/pay.js');
    });

    it('falls back to the generic query when the diff declares nothing', async () => {
        const pipeline = makePipeline();
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });
        // Pure call-site edit — no declaration to extract.
        await svc.buildForReview(prWith('@@ -1,1 +1,1 @@\n+  doThing(a, b);'), 'repo');
        expect(pipeline.getContextForQuestion).toHaveBeenCalled();
    });

    it('survives a pipeline whose optional signals throw', async () => {
        const pipeline = makePipeline({
            safetyCheck: jest.fn(() => { throw new Error('boom'); }),
            getUntestedInBlastRadius: jest.fn(() => { throw new Error('boom'); }),
        });
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });
        const out = await svc.buildForReview(prWith(PATCH), 'repo');
        // Still produced the caller view — a failing optional signal must never
        // take the whole review's context down.
        expect(out.available).toBe(true);
        expect(out.byFile['src/pay.js']).toContain('Called by');
    });

    it('recognises declarations across languages', async () => {
        const pipeline = makePipeline();
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });

        await svc.buildForReview(prWith('@@ -1,1 +1,2 @@\n+def compute_total(items):', 'a.py'), 'r');
        expect(pipeline.getSymbolContext).toHaveBeenCalledWith('compute_total');

        pipeline.getSymbolContext.mockClear();
        await svc.buildForReview(prWith('@@ -1,1 +1,2 @@\n+func HandleRequest(w http.ResponseWriter) {', 'a.go'), 'r');
        expect(pipeline.getSymbolContext).toHaveBeenCalledWith('HandleRequest');

        pipeline.getSymbolContext.mockClear();
        await svc.buildForReview(prWith('@@ -1,1 +1,2 @@\n+export class OrderService {', 'a.ts'), 'r');
        expect(pipeline.getSymbolContext).toHaveBeenCalledWith('OrderService');
    });

    it('caps context size per file', async () => {
        const pipeline = makePipeline({
            getSymbolContext: jest.fn(() => 'x'.repeat(10000)),
        });
        const svc = new ReviewGraphContextService({ codeGraphPipeline: pipeline });
        const out = await svc.buildForReview(prWith(PATCH), 'repo', { maxCharsPerFile: 500 });
        expect(out.byFile['src/pay.js'].length).toBeLessThanOrEqual(500);
    });
});

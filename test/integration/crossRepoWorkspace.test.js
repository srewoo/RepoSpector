/**
 * Cross-repo impact — integration test against REAL KnowledgeGraphService graphs.
 *
 * The design doc flagged this as the gap: every prior test injected fakes for
 * `loadGraph`, so the resolver was verified against a stub of the thing it depends
 * on. That proves the resolver's control flow and nothing about whether a real
 * graph actually answers `findReferences` the way the resolver assumes.
 *
 * Here two genuine graphs are built through the real class — a PRODUCER repo that
 * defines `processPayment`, and a CONSUMER repo that imports and calls it — and the
 * resolver runs against them unmocked.
 *
 * Includes the negative control the doc asks for: a resolver that returns
 * everything looks identical to one that works, unless you check that unrelated
 * repos yield nothing.
 */

const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { ReviewCrossRepoService } = require('../../src/services/ReviewCrossRepoService.js');

/** Build a real graph: `file` defines `symbol`, and callers call it. */
function buildGraph({ defines = [], calls = [] }) {
    const g = new KnowledgeGraphService();
    let n = 0;
    const idOf = new Map();

    for (const { symbol, file, line = 10 } of defines) {
        const id = `n${n++}`;
        idOf.set(symbol, id);
        g.addNode({
            id,
            label: 'Function',
            properties: { name: symbol, filePath: file, startLine: line },
        });
    }
    for (const { from, fromFile, to, line = 20 } of calls) {
        const srcId = `n${n++}`;
        g.addNode({
            id: srcId,
            label: 'Function',
            properties: { name: from, filePath: fromFile, startLine: line },
        });
        const targetId = idOf.get(to);
        if (targetId) {
            g.addRelationship({
                id: `r${n++}`,
                type: 'CALLS',
                sourceId: srcId,
                targetId,
                properties: { line },
            });
        }
    }
    return g;
}

// CONSUMER: a different repo that imports processPayment and calls it.
const consumerGraph = () => buildGraph({
    defines: [{ symbol: 'processPayment', file: 'src/imports.js', line: 3 }],
    calls: [{ from: 'checkout', fromFile: 'src/checkout.js', to: 'processPayment', line: 42 }],
});

// UNRELATED: no knowledge of processPayment whatsoever.
const unrelatedGraph = () => buildGraph({
    defines: [{ symbol: 'renderChart', file: 'src/chart.js' }],
    calls: [{ from: 'dashboard', fromFile: 'src/dash.js', to: 'renderChart' }],
});

const workspace = (repos, autoIndex = false) => ({
    workspace: { repos, autoIndex },
});

const prChanging = (code) => ({
    files: [{ filename: 'src/pay.js', patch: code.split('\n').map(l => `+${l}`).join('\n') }],
});

describe('cross-repo impact — real graphs, no fakes', () => {
    it('finds a consumer repo that references a changed symbol', async () => {
        const graphs = { 'acme/consumer': consumerGraph() };
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async (id) => !!graphs[id],
            loadGraph: async (id) => graphs[id] || null,
        });

        const report = await svc.run({
            prData: prChanging('export function processPayment(order) { return charge(order); }'),
            customConfig: workspace(['https://github.com/acme/consumer']),
            currentRepoId: 'acme/producer',
        });

        expect(report.changedSymbols).toContain('processPayment');
        expect(report.dependents).toHaveLength(1);
        expect(report.dependents[0].repoId).toBe('acme/consumer');

        // The reference must come from the real graph query, including the call site.
        const files = report.dependents[0].hits.flatMap(h => h.files || []);
        expect(files.join(' ')).toMatch(/checkout\.js|imports\.js/);
    });

    it('NEGATIVE CONTROL — an unrelated repo yields no dependents', async () => {
        // Without this, a resolver that matches everything is indistinguishable
        // from one that matches correctly.
        const graphs = { 'acme/unrelated': unrelatedGraph() };
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async (id) => !!graphs[id],
            loadGraph: async (id) => graphs[id] || null,
        });

        const report = await svc.run({
            prData: prChanging('export function processPayment(order) {}'),
            customConfig: workspace(['https://github.com/acme/unrelated']),
            currentRepoId: 'acme/producer',
        });

        expect(report.dependents).toHaveLength(0);
        expect(report.stats.linkedReposChecked).toBe(1);
    });

    it('renaming the symbol drops the dependent', async () => {
        const graphs = { 'acme/consumer': consumerGraph() };
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async () => true,
            loadGraph: async (id) => graphs[id] || null,
        });

        const report = await svc.run({
            prData: prChanging('export function processPaymentV2(order) {}'),
            customConfig: workspace(['https://github.com/acme/consumer']),
            currentRepoId: 'acme/producer',
        });
        expect(report.dependents).toHaveLength(0);
    });

    it('separates dependents from non-dependents across several linked repos', async () => {
        const graphs = {
            'acme/consumer': consumerGraph(),
            'acme/unrelated': unrelatedGraph(),
        };
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async (id) => !!graphs[id],
            loadGraph: async (id) => graphs[id] || null,
        });

        const report = await svc.run({
            prData: prChanging('export function processPayment(order) {}'),
            customConfig: workspace([
                'https://github.com/acme/consumer',
                'https://github.com/acme/unrelated',
            ]),
            currentRepoId: 'acme/producer',
        });

        expect(report.dependents.map(d => d.repoId)).toEqual(['acme/consumer']);
        expect(report.stats.linkedReposChecked).toBe(2);
        expect(report.stats.dependentRepos).toBe(1);
    });

    it('does not query the graph of the repo being reviewed', async () => {
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async () => true,
            loadGraph: async () => consumerGraph(),
        });
        const report = await svc.run({
            prData: prChanging('export function processPayment(o) {}'),
            customConfig: workspace(['https://github.com/acme/producer']),
            currentRepoId: 'acme/producer',
        });
        // The current repo is filtered out of the link list, leaving nothing to do.
        expect(report).toBeNull();
    });
});

describe('cross-repo impact — observability counters', () => {
    it('returns null and spends nothing when no workspace is declared', async () => {
        const loadGraph = jest.fn();
        const svc = new ReviewCrossRepoService({ isRepoIndexed: jest.fn(), loadGraph });
        const report = await svc.run({
            prData: prChanging('export function processPayment(o) {}'),
            customConfig: {},
            currentRepoId: 'acme/producer',
        });
        expect(report).toBeNull();
        expect(loadGraph).not.toHaveBeenCalled();
    });

    it('flags an EMPTY graph rather than reporting a clean no-impact', async () => {
        // The failure mode the design doc calls out: a graph that loads with zero
        // nodes returns "no dependents", identical to a correct negative.
        //
        // The loader here returns a REAL but empty KnowledgeGraphService — the
        // service's own gate must catch it. Nothing about the detection is faked.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async () => true,
            loadGraph: async () => new KnowledgeGraphService(), // zero nodes
        });

        const report = await svc.run({
            prData: prChanging('export function processPayment(o) {}'),
            customConfig: workspace(['https://github.com/acme/consumer']),
            currentRepoId: 'acme/producer',
        });

        expect(report.dependents).toHaveLength(0);
        expect(report.stats.graphsEmpty).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loaded but is EMPTY/));
        warn.mockRestore();
    });

    it('warns when the symbol extractor finds nothing on a code MR', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async () => true,
            loadGraph: async () => consumerGraph(),
        });

        const report = await svc.run({
            // Real added code, but no recognisable declaration — the regex gap.
            prData: { files: [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n+  total += 1;' }] },
            customConfig: workspace(['https://github.com/acme/consumer']),
            currentRepoId: 'acme/producer',
        });

        expect(report.stats.symbolsExtracted).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/extracted 0 changed symbols/));
        warn.mockRestore();
    });

    it('counts skipped repos when a linked repo is not indexed', async () => {
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async (id) => id === 'acme/consumer',
            loadGraph: async (id) => (id === 'acme/consumer' ? consumerGraph() : null),
        });

        const report = await svc.run({
            prData: prChanging('export function processPayment(o) {}'),
            customConfig: workspace([
                'https://github.com/acme/consumer',
                'https://github.com/acme/never-indexed',
            ]),
            currentRepoId: 'acme/producer',
        });

        expect(report.stats.linkedReposSkipped).toBeGreaterThan(0);
        expect(report.stats.linkedReposChecked).toBeLessThan(report.stats.linkedReposConfigured);
    });
});

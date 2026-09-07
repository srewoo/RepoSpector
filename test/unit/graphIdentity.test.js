/**
 * Verifies CodeGraphPipeline tracks WHICH repo its single shared graph
 * instance currently holds (`loadedRepoId`) and exposes that safely via
 * `hasGraphFor(repoId)`.
 *
 * The bug this guards against: `this.graph` is one shared
 * KnowledgeGraphService instance reused across repos. A caller that only
 * checks `graph.nodeCount > 0` cannot tell whose data is resident, so it can
 * silently present repo A's symbols/call sites as facts about repo B.
 * `hasGraphFor` must check identity (loadedRepoId === repoId), not just
 * node count.
 */
const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { CodeGraphPipeline } = require('../../src/services/CodeGraphPipeline.js');

function stubbedGraph() {
    const g = new KnowledgeGraphService();
    g.save = jest.fn().mockResolvedValue();
    g.hasGraph = jest.fn().mockResolvedValue(true);
    g.load = jest.fn().mockResolvedValue({ nodeCount: 0, relationshipCount: 0 });
    g.delete = jest.fn().mockResolvedValue();
    return g;
}

function inMemoryCache() {
    const store = new Map();
    return {
        get: jest.fn(async (id) => store.get(id) || null),
        set: jest.fn(async (id, data) => { store.set(id, data); return true; }),
        delete: jest.fn(async (id) => { store.delete(id); return true; })
    };
}

function fakeOffscreenParser() {
    return {
        analyzeFiles: jest.fn(async (files) => {
            const m = new Map();
            for (const f of files) {
                m.set(f.path, {
                    symbols: [{ name: `sym_${f.path}`, label: 'Function', startLine: 1, endLine: 1, isExported: true }],
                    imports: [], calls: [], heritage: []
                });
            }
            return m;
        })
    };
}

function makePipeline() {
    return new CodeGraphPipeline({
        graph: stubbedGraph(),
        offscreenParser: fakeOffscreenParser(),
        analysisCache: inMemoryCache()
    });
}

const files = [{ path: 'a.js', content: 'const a = 1;' }];

describe('CodeGraphPipeline graph identity (hasGraphFor / loadedRepoId)', () => {
    it('starts with no loaded repo', () => {
        const pipeline = makePipeline();
        expect(pipeline.loadedRepoId).toBeNull();
        expect(pipeline.hasGraphFor('owner/repo')).toBe(false);
    });

    it('sets loadedRepoId after a successful buildGraph', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        expect(pipeline.loadedRepoId).toBe('owner/repoA');
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(true);
    });

    it('sets loadedRepoId after a successful updateGraph', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        await pipeline.updateGraph('owner/repoA', files);
        expect(pipeline.loadedRepoId).toBe('owner/repoA');
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(true);
    });

    it('THE BUG: returns false for a different repo even though a graph with nodes is resident', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);

        // The shared graph instance is non-empty (repo A's data)...
        expect(pipeline.graph.nodeCount).toBeGreaterThan(0);
        // ...but it is NOT repo B's graph, so it must not be usable as one.
        expect(pipeline.hasGraphFor('owner/repoB')).toBe(false);
    });

    it('returns false for a falsy repo id even with a non-empty matching-shaped graph', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        expect(pipeline.hasGraphFor(null)).toBe(false);
        expect(pipeline.hasGraphFor(undefined)).toBe(false);
        expect(pipeline.hasGraphFor('')).toBe(false);
    });

    it('returns false when the matching repo id is loaded but node count is zero', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        pipeline.graph.clear(); // simulate an emptied-out graph, identity unchanged
        expect(pipeline.loadedRepoId).toBe('owner/repoA');
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(false);
    });

    it('returns true only for a matching repo id with a non-empty graph', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(true);
        expect(pipeline.hasGraphFor('owner/repoB')).toBe(false);
    });

    it('loadGraph sets loadedRepoId when a graph is found', async () => {
        const pipeline = makePipeline();
        pipeline.graph.load = jest.fn().mockImplementation(async () => {
            pipeline.graph.nodes.set('n1', { id: 'n1', label: 'Function', properties: { name: 'f', filePath: 'a.js' } });
            return { nodeCount: 1, relationshipCount: 0 };
        });

        await pipeline.loadGraph('owner/repoC');

        expect(pipeline.loadedRepoId).toBe('owner/repoC');
        expect(pipeline.hasGraphFor('owner/repoC')).toBe(true);
    });

    it('loadGraph clears loadedRepoId when nothing is found for that repo', async () => {
        const pipeline = makePipeline();
        pipeline.graph.load = jest.fn().mockResolvedValue({ nodeCount: 0, relationshipCount: 0 });

        await pipeline.loadGraph('owner/repoD');

        expect(pipeline.loadedRepoId).toBeNull();
        expect(pipeline.hasGraphFor('owner/repoD')).toBe(false);
    });

    it('deleteGraph clears loadedRepoId when deleting the currently loaded repo', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);
        expect(pipeline.loadedRepoId).toBe('owner/repoA');

        await pipeline.deleteGraph('owner/repoA');

        expect(pipeline.loadedRepoId).toBeNull();
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(false);
    });

    it('deleteGraph leaves loadedRepoId untouched when deleting a different repo', async () => {
        const pipeline = makePipeline();
        await pipeline.buildGraph('owner/repoA', files);

        await pipeline.deleteGraph('owner/repoB');

        expect(pipeline.loadedRepoId).toBe('owner/repoA');
        expect(pipeline.hasGraphFor('owner/repoA')).toBe(true);
    });
});

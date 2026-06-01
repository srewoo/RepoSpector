/**
 * Verifies CodeGraphPipeline.updateGraph re-parses only changed files and reuses
 * cached analyses for unchanged ones, while still reassembling a correct graph.
 * Graph persistence (IndexedDB) is stubbed since jsdom has no IndexedDB.
 */
const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { CodeGraphPipeline } = require('../../src/services/CodeGraphPipeline.js');

function stubbedGraph() {
    const g = new KnowledgeGraphService();
    g.save = jest.fn().mockResolvedValue();
    g.hasGraph = jest.fn().mockResolvedValue(true);
    g.load = jest.fn().mockResolvedValue({ nodeCount: 0, relationshipCount: 0 });
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

// Offscreen parser stub: produces a trivial analysis (one Function named after the file)
// for every file it is asked to parse, and records which paths it parsed.
function fakeOffscreenParser() {
    const parsedBatches = [];
    return {
        parsedBatches,
        analyzeFiles: jest.fn(async (files) => {
            parsedBatches.push(files.map(f => f.path));
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

describe('CodeGraphPipeline incremental updateGraph', () => {
    it('falls back to a full build when no cache exists, seeding the cache', async () => {
        const offscreenParser = fakeOffscreenParser();
        const analysisCache = inMemoryCache();
        const pipeline = new CodeGraphPipeline({ graph: stubbedGraph(), offscreenParser, analysisCache });

        const files = [
            { path: 'a.js', content: 'const a = 1;' },
            { path: 'b.js', content: 'const b = 2;' }
        ];
        // No cache yet → updateGraph should delegate to a full build.
        await pipeline.updateGraph('owner/repo', files);

        expect(offscreenParser.analyzeFiles).toHaveBeenCalledTimes(1);
        expect(offscreenParser.parsedBatches[0].sort()).toEqual(['a.js', 'b.js']);
        expect(analysisCache.set).toHaveBeenCalled();
    });

    it('re-parses only changed files on a subsequent update', async () => {
        const offscreenParser = fakeOffscreenParser();
        const analysisCache = inMemoryCache();
        const pipeline = new CodeGraphPipeline({ graph: stubbedGraph(), offscreenParser, analysisCache });

        const v1 = [
            { path: 'a.js', content: 'const a = 1;' },
            { path: 'b.js', content: 'const b = 2;' }
        ];
        await pipeline.buildGraph('owner/repo', v1); // seeds cache (parse #1: a,b)

        const v2 = [
            { path: 'a.js', content: 'const a = 1;' },        // unchanged
            { path: 'b.js', content: 'const b = 999;' }       // changed
        ];
        const stats = await pipeline.updateGraph('owner/repo', v2);

        // Second offscreen call should have parsed ONLY b.js
        expect(offscreenParser.parsedBatches.length).toBe(2);
        expect(offscreenParser.parsedBatches[1]).toEqual(['b.js']);
        expect(stats.incremental).toEqual({ changedFiles: 1, reusedFiles: 1 });

        // Graph still contains symbols for both files (reused + reparsed)
        expect(pipeline.graph.findNodeByName('sym_a.js').length).toBe(1);
        expect(pipeline.graph.findNodeByName('sym_b.js').length).toBe(1);
    });

    it('does not call the offscreen parser at all when nothing changed', async () => {
        const offscreenParser = fakeOffscreenParser();
        const analysisCache = inMemoryCache();
        const pipeline = new CodeGraphPipeline({ graph: stubbedGraph(), offscreenParser, analysisCache });

        const files = [{ path: 'a.js', content: 'const a = 1;' }];
        await pipeline.buildGraph('owner/repo', files); // parse #1
        await pipeline.updateGraph('owner/repo', files); // nothing changed

        // Only the initial build parsed; the no-op update parsed nothing.
        expect(offscreenParser.analyzeFiles).toHaveBeenCalledTimes(1);
        expect(pipeline.graph.findNodeByName('sym_a.js').length).toBe(1);
    });
});

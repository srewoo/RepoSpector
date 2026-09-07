const { collectGraphCallers } = require('../../src/utils/graphCallerContext.js');

// `loadedRepoId` defaults to 'r1' to match the repoId most tests below call
// with, mirroring CodeGraphPipeline's real identity tracking: a resident
// graph (nodeCount > 0) is only usable when it belongs to the requested repo.
function makePipeline({ nodeCount = 0, hasGraph, loadGraph, callersFor = {}, loadedRepoId = 'r1' } = {}) {
    const graph = { nodeCount };
    return {
        graph,
        hasGraph: hasGraph || jest.fn().mockResolvedValue(false),
        loadGraph: loadGraph || jest.fn().mockResolvedValue(undefined),
        hasGraphFor(repoId) {
            return !!repoId && repoId === loadedRepoId && graph.nodeCount > 0;
        },
        __callersFor: callersFor
    };
}

describe('collectGraphCallers', () => {
    it('returns [] when pipeline is null/undefined', async () => {
        await expect(collectGraphCallers({ pipeline: null, repoId: 'r1', code: 'x' })).resolves.toEqual([]);
        await expect(collectGraphCallers({ pipeline: undefined, repoId: 'r1', code: 'x' })).resolves.toEqual([]);
    });

    it('returns [] when repoId is falsy even if a graph is already resident (regression for cross-repo contamination bug)', async () => {
        const pipeline = makePipeline({ nodeCount: 5 });
        const result = await collectGraphCallers({ pipeline, repoId: null, code: 'export function charge(a) {}' });
        expect(result).toEqual([]);
        expect(pipeline.hasGraph).not.toHaveBeenCalled();
        expect(pipeline.loadGraph).not.toHaveBeenCalled();
    });

    it('returns [] and never loads when nodeCount is 0 and hasGraph resolves false', async () => {
        const loadGraph = jest.fn().mockResolvedValue(undefined);
        const pipeline = makePipeline({ nodeCount: 0, hasGraph: jest.fn().mockResolvedValue(false), loadGraph });
        const result = await collectGraphCallers({ pipeline, repoId: 'r1', code: 'export function charge(a) {}' });
        expect(result).toEqual([]);
        expect(loadGraph).not.toHaveBeenCalled();
    });

    it('loads the graph once when nodeCount is 0 and hasGraph resolves true', async () => {
        const loadGraph = jest.fn().mockResolvedValue(undefined);
        const pipeline = makePipeline({ nodeCount: 0, hasGraph: jest.fn().mockResolvedValue(true), loadGraph });
        // After loadGraph "runs" the graph is still nodeCount 0 in this fake (load doesn't mutate it),
        // so the result is [] but we assert loadGraph was invoked with the right repoId.
        await collectGraphCallers({ pipeline, repoId: 'r1', code: 'export function charge(a) {}' });
        expect(loadGraph).toHaveBeenCalledTimes(1);
        expect(loadGraph).toHaveBeenCalledWith('r1');
    });

    it('returns caller shape for a resident graph and caps symbols at maxSymbols', async () => {
        jest.resetModules();
        jest.doMock('../../src/utils/declaredSymbols.js', () => ({
            extractDeclaredSymbols: jest.fn().mockReturnValue(['a', 'b', 'c', 'd'])
        }));
        jest.doMock('../../src/utils/graphQueries.js', () => ({
            listCallers: jest.fn((graph, symbol) => {
                if (symbol === 'a') return [{ name: 'caller1', filePath: 'src/x.js', line: 10 }];
                if (symbol === 'b') return [{ name: 'caller2', filePath: 'src/y.js', line: 20 }];
                return [];
            })
        }));
        const { collectGraphCallers: collect } = require('../../src/utils/graphCallerContext.js');
        const pipeline = makePipeline({ nodeCount: 10 });

        const result = await collect({ pipeline, repoId: 'r1', code: 'anything', maxSymbols: 2 });

        expect(result).toEqual([
            { symbol: 'a', callers: [{ name: 'caller1', filePath: 'src/x.js', line: 10 }] },
            { symbol: 'b', callers: [{ name: 'caller2', filePath: 'src/y.js', line: 20 }] }
        ]);

        jest.dontMock('../../src/utils/declaredSymbols.js');
        jest.dontMock('../../src/utils/graphQueries.js');
        jest.resetModules();
    });

    it('returns [] when the resident graph belongs to a different repo (cross-repo identity check)', async () => {
        jest.resetModules();
        jest.doMock('../../src/utils/declaredSymbols.js', () => ({
            extractDeclaredSymbols: jest.fn().mockReturnValue(['a'])
        }));
        jest.doMock('../../src/utils/graphQueries.js', () => ({
            listCallers: jest.fn().mockReturnValue([{ name: 'caller1', filePath: 'src/x.js', line: 10 }])
        }));
        const { collectGraphCallers: collect } = require('../../src/utils/graphCallerContext.js');
        // Pipeline's shared graph is resident with nodes, but it's repo A's graph,
        // and repo B (with no persisted graph of its own) is being requested.
        const pipeline = makePipeline({
            nodeCount: 10,
            loadedRepoId: 'repoA',
            hasGraph: jest.fn().mockResolvedValue(false)
        });

        const result = await collect({ pipeline, repoId: 'repoB', code: 'anything' });

        expect(result).toEqual([]);
        expect(pipeline.loadGraph).not.toHaveBeenCalled();

        jest.dontMock('../../src/utils/declaredSymbols.js');
        jest.dontMock('../../src/utils/graphQueries.js');
        jest.resetModules();
    });

    it('returns [] without throwing when hasGraph rejects', async () => {
        const pipeline = makePipeline({ nodeCount: 0, hasGraph: jest.fn().mockRejectedValue(new Error('boom')) });
        await expect(collectGraphCallers({ pipeline, repoId: 'r1', code: 'export function charge(a) {}' })).resolves.toEqual([]);
    });

    it('returns [] without throwing when loadGraph rejects', async () => {
        const pipeline = makePipeline({
            nodeCount: 0,
            hasGraph: jest.fn().mockResolvedValue(true),
            loadGraph: jest.fn().mockRejectedValue(new Error('boom'))
        });
        await expect(collectGraphCallers({ pipeline, repoId: 'r1', code: 'export function charge(a) {}' })).resolves.toEqual([]);
    });
});

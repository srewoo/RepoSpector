const { listCallers, findSymbolNode } = require('../../src/utils/graphQueries.js');

function makeGraph() {
    const nodes = {
        t1: { id: 't1', label: 'Function', properties: { name: 'charge', filePath: 'src/pay.js', startLine: 10 } },
        t2: { id: 't2', label: 'Function', properties: { name: 'charge', filePath: 'src/legacy/pay.js', startLine: 3 } },
        c1: { id: 'c1', label: 'Function', properties: { name: 'checkout', filePath: 'src/checkout.js', startLine: 40 } },
        c2: { id: 'c2', label: 'Function', properties: { name: 'refund', filePath: 'src/refund.js', startLine: 8 } },
        c3: { id: 'c3', label: 'Function', properties: { name: 'test charge', filePath: 'test/pay.test.js', startLine: 1 } },
    };
    return {
        findNodeByName: (n) => Object.values(nodes).filter(x => x.properties.name === n),
        getNode: (id) => nodes[id],
        getRelationshipsTo: (id) => ({
            t1: [
                { type: 'CALLS', sourceId: 'c1', confidence: 0.9 },
                { type: 'CALLS', sourceId: 'c2', confidence: 0.6 },
                { type: 'CALLS', sourceId: 'c3', confidence: 0.9 },
                { type: 'IMPORTS', sourceId: 'c2' },
            ],
            t2: [{ type: 'CALLS', sourceId: 'c1', confidence: 0.5 }],
        }[id] || []),
    };
}

describe('findSymbolNode', () => {
    it('prefers the node in the given file', () => {
        expect(findSymbolNode(makeGraph(), 'charge', 'src/legacy/pay.js').id).toBe('t2');
    });
    it('falls back to the first match', () => {
        expect(findSymbolNode(makeGraph(), 'charge').id).toBe('t1');
    });
    it('returns null for unknown symbols', () => {
        expect(findSymbolNode(makeGraph(), 'nope')).toBeNull();
    });
});

describe('listCallers', () => {
    it('returns distinct CALLS sources with file and line, excluding tests by default', () => {
        const out = listCallers(makeGraph(), 'charge');
        expect(out.map(c => `${c.filePath}:${c.line}`)).toEqual(['src/checkout.js:40', 'src/refund.js:8']);
    });
    it('excludes files the PR touches', () => {
        const out = listCallers(makeGraph(), 'charge', { excludeFiles: new Set(['src/checkout.js']) });
        expect(out.map(c => c.name)).toEqual(['refund']);
    });
    it('honours limit and keeps test callers when asked', () => {
        const out = listCallers(makeGraph(), 'charge', { excludeTests: false, limit: 3 });
        expect(out).toHaveLength(3);
    });
    it('returns [] when the graph throws', () => {
        const g = { findNodeByName: () => { throw new Error('boom'); } };
        expect(listCallers(g, 'charge')).toEqual([]);
    });
});

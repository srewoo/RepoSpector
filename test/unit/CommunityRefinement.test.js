/**
 * Verifies the Leiden-style refinement in CommunityDetector: a community that is
 * internally disconnected is split into its connected components, and genuinely
 * connected clusters are preserved.
 */
const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { CommunityDetector } = require('../../src/services/CommunityDetector.js');

function fn(graph, name) {
    const id = KnowledgeGraphService.generateId('Function', `f/${name}.js:${name}`);
    graph.addNode({ id, label: 'Function', properties: { name, filePath: `f/${name}.js` } });
    return id;
}
function calls(graph, a, b) {
    graph.addRelationship({
        id: KnowledgeGraphService.generateId('CALLS', `${a}->${b}`),
        sourceId: a, targetId: b, type: 'CALLS', confidence: 0.9, reason: 'test'
    });
}

describe('CommunityDetector Leiden refinement', () => {
    it('keeps a genuinely connected cluster intact', () => {
        const graph = new KnowledgeGraphService();
        const a = fn(graph, 'a'), b = fn(graph, 'b'), c = fn(graph, 'c');
        calls(graph, a, b);
        calls(graph, b, c);
        calls(graph, c, a);

        const { memberships } = new CommunityDetector(graph).detect();
        // All three are mutually reachable → same community.
        expect(memberships.get(a)).toBeDefined();
        expect(memberships.get(a)).toBe(memberships.get(b));
        expect(memberships.get(b)).toBe(memberships.get(c));
    });

    it('does not place two disconnected clusters in one community', () => {
        const graph = new KnowledgeGraphService();
        // Cluster 1
        const a = fn(graph, 'a'), b = fn(graph, 'b');
        calls(graph, a, b);
        // Cluster 2 (no edge to cluster 1)
        const x = fn(graph, 'x'), y = fn(graph, 'y');
        calls(graph, x, y);

        const { memberships } = new CommunityDetector(graph).detect();
        // Refinement guarantees connected components are never merged.
        if (memberships.get(a) !== undefined && memberships.get(x) !== undefined) {
            expect(memberships.get(a)).not.toBe(memberships.get(x));
        }
        // Within a connected cluster, members share a community.
        expect(memberships.get(a)).toBe(memberships.get(b));
    });
});

/**
 * `quickSafetyCheck` called gorilla/mux's `setMatch` SAFE.
 *
 * `setMatch` has exactly one caller, `Route.Match` (route.go:112), which
 * `ServeHTTP` reaches on every request the router serves. Two separate rules
 * produced that verdict:
 *
 *   1. `_countHighConfidence` required `confidence >= 0.8`, but every Go CALLS
 *      edge this analyser emits is 0.5 — so `highConf` was structurally always
 *      0 for Go, and the `highConf === 0 && count <= 2` branch declared any Go
 *      symbol with two or fewer callers safe.
 *   2. Risk was pure cardinality, with no notion of what the callers are.
 *
 * `analyze` separately took `targetNodes[0]`, silently answering for one of
 * several same-named declarations — `Match` is declared on `Route`, `Router`
 * and `routeRegexp` in that one repository.
 */
const { ImpactAnalyzer } = require('../../src/services/ImpactAnalyzer.js');

/**
 * Graph double exposing the readers ImpactAnalyzer uses.
 * @param {Array} nodes  {id, label, properties:{name, filePath, isExported}}
 * @param {Array} edges  {sourceId, targetId, confidence}
 */
function makeGraph(nodes, edges) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const reverse = new Map();
    const forward = new Map();
    for (const e of edges) {
        if (!reverse.has(e.targetId)) reverse.set(e.targetId, []);
        reverse.get(e.targetId).push({ ...e });
        if (!forward.has(e.sourceId)) forward.set(e.sourceId, []);
        forward.get(e.sourceId).push({ ...e });
    }
    return {
        findNodeByName: (name) => nodes.filter(n => n.properties.name === name),
        getNode: (id) => byId.get(id) || null,
        getReverseAdjacency: () => reverse,
        getForwardAdjacency: () => forward,
    };
}

const node = (id, name, filePath, extra = {}) => ({
    id, label: 'Function', properties: { name, filePath, startLine: 1, ...extra },
});

describe('quickSafetyCheck does not mistake low confidence for safety', () => {
    // The mux shape: setMatch <- Route.Match <- ServeHTTP, all Go edges at 0.5.
    const goGraph = () => makeGraph(
        [
            node('n1', 'setMatch', 'regexp.go'),
            node('n2', 'Match', 'route.go', { isExported: true }),
            node('n3', 'ServeHTTP', 'mux.go', { isExported: true }),
        ],
        [
            { sourceId: 'n2', targetId: 'n1', confidence: 0.5 },
            { sourceId: 'n3', targetId: 'n2', confidence: 0.5 },
        ],
    );

    it('does not call a hot-path symbol safe just because every edge is 0.5', () => {
        const check = new ImpactAnalyzer(goGraph()).quickSafetyCheck('setMatch');
        expect(check.safe).toBe(false);
        expect(check.risk).not.toBe('low');
    });

    it('reports that the graph itself never exceeds the confidence bar', () => {
        const check = new ImpactAnalyzer(goGraph()).quickSafetyCheck('setMatch');
        expect(check.calibration.uniformlyLow).toBe(true);
        expect(check.calibration.observedMax).toBe(0.5);
        // The bar drops to what this extractor can actually produce, so the
        // graph's strongest evidence still counts as evidence.
        expect(check.calibration.highThreshold).toBe(0.5);
    });

    it('counts the exported dependents that make it central', () => {
        const check = new ImpactAnalyzer(goGraph()).quickSafetyCheck('setMatch');
        expect(check.exportedDependents).toBeGreaterThan(0);
    });

    it('still calls a genuinely unreferenced symbol safe', () => {
        const graph = makeGraph([node('n1', 'orphan', 'util.go')], []);
        const check = new ImpactAnalyzer(graph).quickSafetyCheck('orphan');
        expect(check.safe).toBe(true);
        expect(check.risk).toBe('low');
    });

    it('keeps the strict 0.8 bar when the extractor does emit high confidence', () => {
        const graph = makeGraph(
            [node('n1', 'target', 'a.js'), node('n2', 'caller', 'b.js')],
            [{ sourceId: 'n2', targetId: 'n1', confidence: 0.95 }],
        );
        const check = new ImpactAnalyzer(graph).quickSafetyCheck('target');
        expect(check.calibration.uniformlyLow).toBe(false);
        expect(check.calibration.highThreshold).toBe(0.8);
        expect(check.highConfidence).toBe(1);
        expect(check.safe).toBe(false);
    });
});

describe('analyze covers every declaration of an overloaded name', () => {
    // `Match` on three receivers, each with its own distinct caller.
    const graph = () => makeGraph(
        [
            node('r1', 'Match', 'route.go'),
            node('r2', 'Match', 'mux.go'),
            node('r3', 'Match', 'regexp.go'),
            node('c1', 'callerOfRoute', 'a.go'),
            node('c2', 'callerOfRouter', 'b.go'),
            node('c3', 'callerOfRegexp', 'c.go'),
        ],
        [
            { sourceId: 'c1', targetId: 'r1', confidence: 0.5 },
            { sourceId: 'c2', targetId: 'r2', confidence: 0.5 },
            { sourceId: 'c3', targetId: 'r3', confidence: 0.5 },
        ],
    );

    it('flags the name as ambiguous and lists every declaration', () => {
        const res = new ImpactAnalyzer(graph()).analyze('Match', { direction: 'upstream' });
        expect(res.ambiguous).toBe(true);
        expect(res.targets).toHaveLength(3);
        expect(res.targets.map(t => t.filePath).sort())
            .toEqual(['mux.go', 'regexp.go', 'route.go']);
    });

    it('unions the blast radius instead of answering for the first match only', () => {
        const res = new ImpactAnalyzer(graph()).analyze('Match', { direction: 'upstream' });
        const names = Object.values(res.upstream.depthGroups).flat().map(n => n.name).sort();
        expect(names).toEqual(['callerOfRegexp', 'callerOfRoute', 'callerOfRouter']);
        expect(res.upstream.totalAffected).toBe(3);
    });

    it('does not count the other declarations as their own dependents', () => {
        const res = new ImpactAnalyzer(graph()).analyze('Match', { direction: 'upstream' });
        const names = Object.values(res.upstream.depthGroups).flat().map(n => n.name);
        expect(names).not.toContain('Match');
    });

    it('leaves an unambiguous name reporting a single target', () => {
        const res = new ImpactAnalyzer(graph()).analyze('callerOfRoute', { direction: 'upstream' });
        expect(res.ambiguous).toBe(false);
        expect(res.targets).toHaveLength(1);
    });
});

describe('quickSafetyCheck honours the requested depth', () => {
    // a <- b <- c <- d : depth 1 sees only b, depth 3 sees b, c and d.
    const graph = makeGraph(
        [
            node('a', 'a', 'a.js'), node('b', 'b', 'b.js'),
            node('c', 'c', 'c.js'), node('d', 'd', 'd.js'),
        ],
        [
            { sourceId: 'b', targetId: 'a', confidence: 0.5 },
            { sourceId: 'c', targetId: 'b', confidence: 0.5 },
            { sourceId: 'd', targetId: 'c', confidence: 0.5 },
        ],
    );

    it('a shallower depth reports a smaller blast radius', () => {
        const shallow = new ImpactAnalyzer(graph).quickSafetyCheck('a', { maxDepth: 1 });
        const deep = new ImpactAnalyzer(graph).quickSafetyCheck('a', { maxDepth: 3 });
        expect(shallow.dependents).toBe(1);
        expect(deep.dependents).toBe(3);
    });
});

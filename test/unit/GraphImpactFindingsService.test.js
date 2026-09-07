const { GraphImpactFindingsService } = require('../../src/services/GraphImpactFindingsService.js');
const { findingBlocks } = require('../../src/utils/failLevel.js');

const patch = (lines) => ['@@ -1,3 +1,3 @@', ...lines].join('\n');

function makeGraph(callers = ['src/checkout.js']) {
    const nodes = {
        t1: { id: 't1', label: 'Function', properties: { name: 'charge', filePath: 'src/pay.js', startLine: 1, isExported: true, isTested: false } },
    };
    callers.forEach((f, i) => {
        nodes[`c${i}`] = { id: `c${i}`, label: 'Function', properties: { name: `caller${i}`, filePath: f, startLine: 10 + i } };
    });
    return {
        findNodeByName: (n) => Object.values(nodes).filter(x => x.properties.name === n),
        getNode: (id) => nodes[id],
        getRelationshipsTo: (id) => id === 't1'
            ? callers.map((_, i) => ({ type: 'CALLS', sourceId: `c${i}`, confidence: 0.9 }))
            : [],
    };
}

function makeImpact({ untested = [], risk = 'low', safe = true } = {}) {
    return {
        findUntestedInBlastRadius: jest.fn(() => ({ found: true, totalAffected: 3, untested })),
        quickSafetyCheck: jest.fn(() => ({ safe, risk, reason: `${risk} risk` })),
    };
}

const prData = {
    files: [{
        filename: 'src/pay.js',
        patch: patch(['-export function charge(amount, currency) {', '+export function charge(amount) {', '   return amount;']),
    }],
};

describe('GraphImpactFindingsService', () => {
    it('emits a signature-changed finding naming callers outside the PR', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph(['src/checkout.js', 'src/refund.js']), impactAnalyzer: makeImpact() });
        const { findings, stats } = svc.build(prData);
        const sig = findings.find(f => f.rule === 'graph/signature-changed-callers');
        expect(sig).toMatchObject({ file: 'src/pay.js', line: 1, severity: 'high', source: 'graph', tool: 'code-graph', category: 'logic' });
        expect(sig.title).toMatch(/2 caller\(s\) outside this PR/);
        expect(sig.evidence).toMatch(/src\/checkout\.js:10/);
        expect(sig.description).toMatch(/\(amount, currency\)/);
        expect(sig.description).toMatch(/\(amount\)/);
        expect(stats.signatureChanges).toBe(1);
    });

    it('ignores callers inside the PR and test callers', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph(['src/pay.js', 'test/pay.test.js']), impactAnalyzer: makeImpact() });
        const { findings } = svc.build(prData);
        expect(findings.find(f => f.rule === 'graph/signature-changed-callers')).toBeUndefined();
    });

    it('stays silent on a compatible signature change', () => {
        const compatible = { files: [{ filename: 'src/pay.js', patch: patch(['-function charge(amount) {', '+function charge(amount, currency = "USD") {']) }] };
        const svc = new GraphImpactFindingsService({ graph: makeGraph(), impactAnalyzer: makeImpact() });
        expect(svc.build(compatible).findings.filter(f => f.rule === 'graph/signature-changed-callers')).toHaveLength(0);
    });

    it('emits an untested-blast-radius finding listing untested symbols', () => {
        const impact = makeImpact({ untested: [{ name: 'refund', filePath: 'src/refund.js' }, { name: 'settle', filePath: 'src/settle.js' }] });
        const svc = new GraphImpactFindingsService({ graph: makeGraph([]), impactAnalyzer: impact });
        const f = svc.build(prData).findings.find(x => x.rule === 'graph/untested-blast-radius');
        expect(f).toMatchObject({ severity: 'low', category: 'coverage', source: 'graph' });
        expect(f.description).toMatch(/`refund` \(src\/refund\.js\)/);
        expect(impact.findUntestedInBlastRadius).toHaveBeenCalledWith('charge', { maxDepth: 2 });
    });

    it('escalates a high-risk symbol to a human instead of asserting a defect', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph([]), impactAnalyzer: makeImpact({ safe: false, risk: 'high' }) });
        const f = svc.build(prData).findings.find(x => x.rule === 'graph/high-risk-symbol');
        expect(f).toMatchObject({ severity: 'medium', needsHumanReview: true, expertise: 'architecture' });
        expect(f.escalationReason).toMatch(/high risk/);
    });

    it('escalates critical risk too — the widest blast radius must not be skipped', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph([]), impactAnalyzer: makeImpact({ safe: false, risk: 'critical' }) });
        const f = svc.build(prData).findings.find(x => x.rule === 'graph/high-risk-symbol');
        expect(f).toMatchObject({ severity: 'medium', needsHumanReview: true, expertise: 'architecture' });
    });

    it('does not escalate medium risk', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph([]), impactAnalyzer: makeImpact({ safe: false, risk: 'medium' }) });
        expect(svc.build(prData).findings.find(x => x.rule === 'graph/high-risk-symbol')).toBeUndefined();
    });

    it('caps output and reports the cap', () => {
        const files = Array.from({ length: 10 }, (_, i) => ({
            filename: `src/f${i}.js`,
            patch: patch([`-export function fn${i}(a, b) {`, `+export function fn${i}(a) {`]),
        }));
        const graph = {
            findNodeByName: (n) => [{ id: n, properties: { name: n, filePath: 'x.js' } }],
            getNode: () => ({ properties: { name: 'c', filePath: 'src/other.js', startLine: 1 } }),
            getRelationshipsTo: () => [{ type: 'CALLS', sourceId: 'c', confidence: 0.9 }],
        };
        const svc = new GraphImpactFindingsService({ graph, impactAnalyzer: makeImpact() });
        const { findings, stats } = svc.build({ files }, { maxFindings: 4 });
        expect(findings).toHaveLength(4);
        expect(stats.capped).toBe(true);
    });

    it('skips test files and returns nothing without a graph', () => {
        const svc = new GraphImpactFindingsService({ graph: null, impactAnalyzer: null });
        expect(svc.build(prData)).toEqual({ findings: [], stats: { symbols: 0, signatureChanges: 0, untested: 0, escalations: 0, capped: false } });
        const svc2 = new GraphImpactFindingsService({ graph: makeGraph(), impactAnalyzer: makeImpact() });
        expect(svc2.build({ files: [{ filename: 'test/pay.test.js', patch: prData.files[0].patch }] }).findings).toHaveLength(0);
    });

    it('never throws when the analyzer throws', () => {
        const impact = { findUntestedInBlastRadius: () => { throw new Error('x'); }, quickSafetyCheck: () => { throw new Error('y'); } };
        const svc = new GraphImpactFindingsService({ graph: makeGraph(), impactAnalyzer: impact });
        expect(() => svc.build(prData)).not.toThrow();
    });

    it('reports stats for what actually survives the cap, not everything found', () => {
        const files = Array.from({ length: 10 }, (_, i) => ({
            filename: `src/f${i}.js`,
            patch: patch([`-export function fn${i}(a, b) {`, `+export function fn${i}(a) {`]),
        }));
        const graph = {
            findNodeByName: (n) => [{ id: n, properties: { name: n, filePath: 'x.js' } }],
            getNode: () => ({ properties: { name: 'c', filePath: 'src/other.js', startLine: 1 } }),
            getRelationshipsTo: () => [{ type: 'CALLS', sourceId: 'c', confidence: 0.9 }],
        };
        const svc = new GraphImpactFindingsService({ graph, impactAnalyzer: makeImpact() });
        const { findings, stats } = svc.build({ files }, { maxFindings: 4 });
        // 10 signature-changed findings were found, but only 4 survive the cap —
        // the stat must describe the 4, not the 10.
        expect(findings).toHaveLength(4);
        expect(stats.signatureChanges).toBe(4);
    });

    it('marks every finding deterministic, so it can block a merge and is not mislabelled AI output', () => {
        const svc = new GraphImpactFindingsService({ graph: makeGraph(['src/checkout.js']), impactAnalyzer: makeImpact() });
        const { findings } = svc.build(prData);
        const sig = findings.find(f => f.rule === 'graph/signature-changed-callers');
        expect(sig.deterministic).toBe(true);
        expect(findingBlocks(sig, 'high')).toBe(true);
    });
});

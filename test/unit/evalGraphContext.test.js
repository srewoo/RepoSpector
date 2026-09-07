const { buildGraphFromCase, graphFindingsForCase } = require('../../eval/lib/graphContext.js');
const { normalizeStaticFinding } = require('../../src/utils/findingsFlatten.js');

const kase = {
    prData: {
        files: [{
            filename: 'src/pay.js',
            patch: ['@@ -1,3 +1,3 @@', '-export function charge(amount, currency) {', '+export function charge(amount) {', '   return amount;', ' }'].join('\n'),
        }],
    },
    fileContents: {
        'src/pay.js': 'export function charge(amount) {\n  return amount;\n}\n',
        'src/checkout.js': "import { charge } from './pay.js';\nexport function checkout(cart) {\n  return charge(cart.total, 'USD');\n}\n",
        'test/checkout.test.js': "import { checkout } from '../src/checkout.js';\ntest('x', () => checkout({ total: 1 }));\n",
    },
};

describe('buildGraphFromCase', () => {
    it('builds a graph with nodes and call edges from fileContents', () => {
        const g = buildGraphFromCase(kase);
        expect(g.available).toBe(true);
        expect(g.stats.nodes).toBeGreaterThan(0);
        expect(g.stats.callEdges).toBeGreaterThan(0);
    });
    it('is unavailable without contents', () => {
        expect(buildGraphFromCase({ prData: kase.prData })).toMatchObject({ available: false });
    });
});

describe('graphFindingsForCase', () => {
    it('finds the un-updated caller in another file', () => {
        const { findings } = graphFindingsForCase(kase);
        expect(findings.some(f => f.rule === 'graph/signature-changed-callers' && /src\/checkout\.js/.test(f.evidence))).toBe(true);
    });

    // Regression: eval/run.js must inject graph findings AFTER the gates, not
    // through `staticFindings`/`buildCanonicalFindings`. If someone later
    // routes them back through the flattener, `normalizeStaticFinding` erases
    // `source: 'graph'` (only 'external' is exempted — see that function's
    // comment), which both mislabels the exported prediction's origin and
    // exposes the finding to gates built for model-asserted claims that a
    // graph fact carries no evidence for. This test documents why the
    // pipeline placement in eval/run.js matters, independent of running the
    // whole harness.
    it('produces findings whose source would be corrupted by the static flattener', () => {
        const { findings } = graphFindingsForCase(kase);
        expect(findings.length).toBeGreaterThan(0);
        for (const f of findings) {
            expect(f.source).toBe('graph');
        }

        const normalized = findings.map(normalizeStaticFinding);
        for (const n of normalized) {
            // This is the bug being guarded against: if graph findings were
            // ever merged into staticFindings again, this relabelling would
            // silently fire.
            expect(n.source).toBe('static');
            expect(n.source).not.toBe('graph');
        }
    });
});

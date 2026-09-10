/**
 * P2-2 — one completeness and finding contract across every adapter.
 *
 * The plan is explicit that a big-bang extraction of the 3,250-line handler is
 * the riskiest refactor available, and that the shared completeness contract
 * from P0-1 should become the SEAM instead. This file is what makes that seam
 * real: equivalent fixture input, run through each adapter, must produce
 * consistent validation and completeness semantics — and no adapter may
 * silently drop proof or failure metadata on the way through.
 *
 * It is a contract test, not an integration test of three live products. It
 * exercises the shared modules each product path consumes, which is the only
 * part that CAN be shared today and the part a later extraction has to keep
 * behaving identically.
 */
const {
    createCompleteness,
    mergeCompleteness,
    isComplete,
    governVerdict,
    INCOMPLETE_VERDICT,
} = require('../../src/utils/reviewCompleteness.js');
const { buildVerdictReport, VERDICT } = require('../../src/services/reviewSchema.js');
const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');
const { validationStatusOf } = require('../../src/utils/findingClaim.js');
const { admitDeterministic, ASSERTION } = require('../../src/utils/deterministicAdmission.js');

const prData = {
    state: 'open',
    isDraft: false,
    mergeable: true,
    stats: { additions: 1, deletions: 0 },
    files: [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 }],
    author: { login: 'someone' },
    title: 'change',
};

/**
 * The three engine shapes each product path supplies to the shared
 * orchestrator: the extension's multi-pass engine, the API worker's
 * BackendDeepEngine, and a legacy/stub engine that predates the contract.
 */
const engines = {
    'extension-shaped': (over = {}) => ({
        execute: async () => ({
            analysis: '', perFileFindings: [], failedFiles: [],
            stats: { parseFailures: 0 },
            completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 1 }),
            ...over,
        }),
    }),
    'api-shaped': (over = {}) => ({
        execute: async () => ({
            analysis: '', perFileFindings: [], failedFiles: [],
            tokenUsage: { input: 0, output: 0 },
            completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 1 }),
            ...over,
        }),
    }),
    'legacy-shaped': (over = {}) => ({
        // No completeness field at all — the shape that existed before P0-1.
        execute: async () => ({ analysis: '', perFileFindings: [], failedFiles: [], ...over }),
    }),
};

describe('every adapter reaches the same verdict on equivalent input', () => {
    for (const [name, make] of Object.entries(engines)) {
        it(`${name}: a complete clean run approves`, async () => {
            const report = await new ReviewOrchestrator({ multiPassEngine: make() }).review(prData);
            expect(report.verdict).toBe(VERDICT.APPROVE);
            expect(report.meta.incomplete).toBe(false);
        });

        it(`${name}: a failed unit prevents approval`, async () => {
            const engine = make({
                failedFiles: ['a.js'],
                completeness: createCompleteness({
                    expectedUnits: 1, inspectedUnits: 0, failedUnits: ['a.js'],
                }),
            });
            const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);
            expect(report.verdict).toBe(VERDICT.INCOMPLETE);
            expect(report.meta.incompleteReasons.length).toBeGreaterThan(0);
        });

        it(`${name}: a blocking finding still blocks when the run was incomplete`, async () => {
            const engine = make({
                perFileFindings: [{
                    file: 'a.js',
                    findings: [{ severity: 'critical', file: 'a.js', line: 2, title: 'auth bypass' }],
                }],
                failedFiles: ['b.js'],
                completeness: createCompleteness({
                    expectedUnits: 2, inspectedUnits: 1, failedUnits: ['b.js'],
                }),
            });
            const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);
            expect(report.verdict).toBe(VERDICT.BLOCK);
            expect(report.meta.incomplete).toBe(true);
        });
    }
});

describe('no adapter may drop proof or failure metadata', () => {
    it('a parse failure survives the orchestrator, whatever shape reported it', async () => {
        const viaStats = await new ReviewOrchestrator({
            multiPassEngine: engines['legacy-shaped']({ stats: { parseFailures: 1 } }),
        }).review(prData);
        const viaContract = await new ReviewOrchestrator({
            multiPassEngine: engines['extension-shaped']({
                completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 0, parseFailures: 1 }),
            }),
        }).review(prData);

        expect(viaStats.meta.completeness.parseFailures).toBe(1);
        expect(viaContract.meta.completeness.parseFailures).toBe(1);
        expect(viaStats.verdict).toBe(viaContract.verdict);
    });

    it('merging contracts from several sources loses none of them', () => {
        const merged = mergeCompleteness(
            { parseFailures: 1 },
            { failedUnits: ['a.js'] },
            { omissions: [{ kind: 'diff-budget', detail: 'b.js' }] },
            { unavailableChecks: [{ name: 'deep-review', reason: 'no credentials' }] },
        );
        expect(isComplete(merged)).toBe(false);
        expect(merged.parseFailures).toBe(1);
        expect(merged.failedUnits).toHaveLength(1);
        expect(merged.omissions).toHaveLength(1);
        expect(merged.unavailableChecks).toHaveLength(1);
    });

    it('the approval rule is identical wherever it is applied', () => {
        const incomplete = createCompleteness({ parseFailures: 1 });
        // Directly…
        expect(governVerdict({ verdict: 'APPROVED' }, incomplete).verdict).toBe(INCOMPLETE_VERDICT);
        // …and through the report builder every path uses.
        expect(buildVerdictReport({ findings: [], completeness: incomplete }).verdict)
            .toBe(VERDICT.INCOMPLETE);
    });
});

describe('the finding contract is the same across sources', () => {
    it('a model finding carries what backs it, never "proven"', () => {
        expect(validationStatusOf({ evidence: 'return x;' })).toBe('evidence-quoted');
        expect(validationStatusOf({ confidence: 0.99, score: 10 })).toBe('unvalidated');
    });

    it('a scanner finding is reported as reported, not as reproduced', () => {
        const { admitted } = admitDeterministic(
            [{ file: 'a.js', line: 1, tool: 'codeql', ruleId: 'js/xss', severity: 'high' }],
            'scanner',
        );
        expect(admitted[0].assertionLevel).toBe(ASSERTION.TOOL_REPORTED);
        expect(admitted[0].attribution.kind).toBe('scanner');
    });

    it('an unvalidated graph inference cannot block, a validated one can', () => {
        const base = { file: 'a.js', line: 1, rule: 'graph/signature-changed-callers', severity: 'high' };
        expect(admitDeterministic([{ ...base, assertionLevel: ASSERTION.GRAPH_INFERRED }], 'graph')
            .admitted[0].blocking).toBe(false);
        expect(admitDeterministic([{ ...base, assertionLevel: ASSERTION.VALIDATED }], 'graph')
            .admitted[0].blocking).toBe(true);
    });
});

describe('the shared package exports the seam', () => {
    it('review-core re-exports the completeness contract', () => {
        // The API worker imports the rule from this package. Asserted against
        // the export list rather than by importing it: jest's babel transform
        // does not cover `packages/`, and the package's own ESM entry point is
        // exercised by the MCP and API suites in CI.
        const fs = require('node:fs');
        const index = fs.readFileSync(
            require.resolve('../../packages/review-core/src/index.js'), 'utf8',
        );
        for (const name of ['createCompleteness', 'mergeCompleteness', 'governVerdict', 'isComplete']) {
            expect(index).toContain(name);
        }
        expect(index).toContain("from './reviewCompleteness.js'");

        // And the shim points at the one implementation, so the two paths
        // cannot drift into enforcing different rules.
        const shim = fs.readFileSync(
            require.resolve('../../packages/review-core/src/reviewCompleteness.js'), 'utf8',
        );
        expect(shim).toContain('src/utils/reviewCompleteness.js');
    });
});

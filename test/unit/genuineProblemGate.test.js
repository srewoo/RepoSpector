const {
    filterGenuineProblems,
    buildPrecisionAnalysis,
    summarizeGenuineProblems,
} = require('../../src/utils/genuineProblemGate.js');

const realBug = (overrides = {}) => ({
    file: 'src/auth.js',
    line: 42,
    severity: 'high',
    type: 'security',
    title: 'Authorization check uses the caller-supplied owner id',
    description: 'A user can read another account by changing ownerId.',
    evidence: 'return db.get(req.query.ownerId)',
    confidence: 0.94,
    score: 9,
    scoreSource: 'model',
    _evidence: { citedLine: 'return db.get(req.query.ownerId)' },
    ...overrides,
});

describe('filterGenuineProblems', () => {
    it('keeps a concrete, high-confidence, high-value defect', () => {
        const result = filterGenuineProblems([realBug()]);
        expect(result.findings).toHaveLength(1);
        expect(result.stats.kept).toBe(1);
    });

    it.each([
        ['style commentary', realBug({ type: 'style', title: 'Prefer a clearer name' })],
        ['missing tests', realBug({ type: 'testing', title: 'No test for this function' })],
        ['low confidence', realBug({ confidence: 0.61 })],
        ['low reviewer value', realBug({ score: 5 })],
        ['default score after scorer failure', realBug({ score: 5, scoreSource: 'default' })],
        ['no changed-code evidence', realBug({ evidence: null, _evidence: null })],
        ['open question', realBug({ needsHumanReview: true })],
        ['nitpick severity', realBug({ severity: 'low' })],
    ])('suppresses %s', (_label, finding) => {
        const result = filterGenuineProblems([finding]);
        expect(result.findings).toHaveLength(0);
        expect(result.stats.dropped).toBe(1);
    });

    it('keeps a confirmed secret without requiring an LLM value score', () => {
        const result = filterGenuineProblems([{
            file: '.env',
            severity: 'critical',
            category: 'security',
            title: 'GitHub token exposed',
            tool: 'secrets',
            ruleId: 'github-token',
            confidence: 0.95,
        }]);
        expect(result.findings).toHaveLength(1);
    });

    it('drops a missing-test finding on its own — the post-gate re-add in prReviewHandlers.js is what saves it, not an exemption here', () => {
        // Shape produced by findMissingTests() (src/utils/missingTestFinder.js):
        // `severity: 'low'`, `source: 'static'`, no `tool` field. Asserted
        // directly against the gate (not through the full review pipeline) so
        // this fails the moment someone "simplifies" prReviewHandlers.js by
        // exempting this rule inside the gate instead of re-adding it after —
        // the opposite fix from the one intended, and the one this test guards
        // against alongside missingTestFindingReview.test.js's positive case.
        const missingTestFinding = {
            file: 'src/pricing.js',
            line: 1,
            severity: 'low',
            source: 'static',
            rule: 'static/missing-test',
            ruleId: 'missing-test',
            title: 'New exported `calculateWidgetPrice` is not mentioned by any test in this PR',
            description: 'This diff adds the exported symbol `calculateWidgetPrice` in `src/pricing.js`, and no test file changed by this PR references it by name.',
            suggestion: 'Add a test that calls `calculateWidgetPrice` directly, or note here which existing test covers it.',
        };
        const result = filterGenuineProblems([missingTestFinding]);
        expect(result.findings).toHaveLength(0);
        expect(result.dropped).toHaveLength(1);
        expect(result.dropped[0]._precisionDrop).toBe('non-problem-severity');
    });

    it('keeps only proven cross-repo breakage, not a general dependency notice', () => {
        const breaking = {
            source: 'cross-repo', severity: 'blocking', confidence: 0.8,
            crossRepo: { symbol: 'getUser' }, title: 'getUser removed',
        };
        const advisory = { ...breaking, severity: 'suggestion', confidence: 0.5 };
        const result = filterGenuineProblems([breaking, advisory]);
        expect(result.findings).toEqual([breaking]);
    });
});

describe('precision result rendering', () => {
    it('states clean plainly when no problems survive', () => {
        expect(buildPrecisionAnalysis([])).toContain('No genuine problems were found');
    });

    it('does not call a skipped review clean', () => {
        const text = buildPrecisionAnalysis([], { skipped: true, reason: 'Draft PR' });
        expect(text).toContain('Review not completed');
        expect(text).not.toContain('Clean review');
    });

    it('summarizes only the accepted set', () => {
        expect(summarizeGenuineProblems([
            realBug(),
            realBug({ severity: 'critical', type: 'bug' }),
        ])).toEqual({
            total: 2,
            bySeverity: { high: 1, critical: 1 },
            byCategory: { security: 1, bug: 1 },
        });
    });
});

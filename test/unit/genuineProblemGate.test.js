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
        expect(result.findings).toEqual([{ ...breaking, blocking: true }]);
    });
});

describe('scorer outage', () => {
    it('keeps a blocking finding whose score is the outage default, tagged', () => {
        const result = filterGenuineProblems([realBug({ score: 5, scoreSource: 'default', severity: 'high' })]);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]._scoreUnavailable).toBe(true);
    });

    it('still drops a medium finding whose score is the outage default', () => {
        const result = filterGenuineProblems([realBug({ score: 5, scoreSource: 'default', severity: 'medium' })]);
        expect(result.findings).toHaveLength(0);
        expect(result.dropped[0]._precisionDrop).toBe('reviewer-value');
    });

    it('still drops a model-scored finding below minScore', () => {
        const result = filterGenuineProblems([realBug({ score: 5, scoreSource: 'model' })]);
        expect(result.findings).toHaveLength(0);
    });

    it('keeps a high-severity finding whose scorer never ran (scoreSource null, no score)', () => {
        const result = filterGenuineProblems([realBug({ score: null, scoreSource: null, severity: 'high' })]);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]._scoreUnavailable).toBe(true);
    });

    it('keeps a high-severity finding built without a scoreSource field at all', () => {
        const finding = realBug({ score: null, severity: 'high' });
        delete finding.scoreSource;
        const result = filterGenuineProblems([finding]);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]._scoreUnavailable).toBe(true);
    });

    it('still rejects a medium-severity finding with no score at all as reviewer-value', () => {
        const result = filterGenuineProblems([realBug({ score: null, scoreSource: null, severity: 'medium' })]);
        expect(result.findings).toHaveLength(0);
        expect(result.dropped[0]._precisionDrop).toBe('reviewer-value');
    });

    it('keeps a model-scored finding at or above minScore and does not tag it unavailable', () => {
        const result = filterGenuineProblems([realBug({ score: 7, scoreSource: 'model' })]);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]._scoreUnavailable).toBeUndefined();
    });
});

describe('survivors are marked blocking', () => {
    it('sets blocking=true on every kept finding', () => {
        const result = filterGenuineProblems([realBug()]);
        expect(result.findings[0].blocking).toBe(true);
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

/**
 * The scoring-outage path (a scorer throw, one failed batch of fifteen, or
 * `scoreFindings: false`) is exactly the path this branch exists to protect.
 * Its severity allowlist has to be the WHOLE blocking equivalence class —
 * `blocker` and `error` arrive from some provider paths (findingsFlatten.js)
 * — or a byte-identical defect is deleted purely because of its label.
 */
describe('unscored findings: the blocking severity class is complete', () => {
    const { BLOCKING_SEVERITIES } = require('../../src/utils/findingsFlatten.js');

    it.each([...BLOCKING_SEVERITIES])('keeps an unscored %s finding', (severity) => {
        const result = filterGenuineProblems(
            [realBug({ severity, score: 5, scoreSource: 'default' })],
            { minConfidence: 0.8, minScore: 7 },
        );
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]._scoreUnavailable).toBe(true);
    });

    it('an unscored low-value severity is still rejected as reviewer-value', () => {
        const result = filterGenuineProblems(
            [realBug({ severity: 'medium', score: 5, scoreSource: 'default' })],
            { minConfidence: 0.8, minScore: 7 },
        );
        expect(result.findings).toHaveLength(0);
        expect(result.stats.byReason['reviewer-value']).toBe(1);
    });

    it('the gate and findingsFlatten share one definition of "blocking"', () => {
        expect([...BLOCKING_SEVERITIES].sort())
            .toEqual(['blocker', 'blocking', 'critical', 'error', 'high']);
    });
});

describe('buildPrecisionAnalysis is exact about which gates ran', () => {
    it('does not claim every reported finding cleared the reviewer-value gate', () => {
        const text = buildPrecisionAnalysis([realBug()]);
        expect(text).not.toMatch(/passed the confidence and reviewer-value gates/);
        expect(text).toMatch(/cleared the confidence gate/);
        expect(text).toMatch(/scoring was unavailable/);
    });
});

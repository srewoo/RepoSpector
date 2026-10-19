/**
 * Rubric mode of the precision gate (spec §1.3 step 7, §2.5): the independent
 * 0-100 rubric score replaces the self-reported confidence and the 1-10 value
 * score as the threshold. Unscored findings are kept but never block.
 */
const { filterGenuineProblems, buildPrecisionAnalysis } = require('../../src/utils/genuineProblemGate.js');

const rubric = (status, score = null, reason = 'r') => ({
    status, score, rawScore: score, preExisting: false, quotedRule: null, reason, capReason: null,
});

const bug = (over = {}) => ({
    file: 'src/auth.js',
    line: 42,
    severity: 'high',
    source: 'llm',
    title: 'Authorization check uses the caller-supplied owner id',
    description: 'A user can read another account by changing ownerId.',
    evidence: 'return db.get(req.query.ownerId)',
    _evidence: { citedLine: 'return db.get(req.query.ownerId)' },
    ...over,
});

describe('filterGenuineProblems — rubric mode', () => {
    it('keeps a finding at or above minRubricScore even with low self-reported confidence', () => {
        const res = filterGenuineProblems([bug({ confidence: 0.3, rubric: rubric('scored', 80) })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].blocking).toBe(true);
    });

    it('drops a scored finding below minRubricScore with reason rubric-score', () => {
        const res = filterGenuineProblems([bug({ rubric: rubric('scored', 75) })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(0);
        expect(res.dropped[0]._precisionDrop).toBe('rubric-score');
        expect(res.stats.byReason['rubric-score']).toBe(1);
    });

    it('keeps an unscored finding as not-verified and non-blocking', () => {
        const res = filterGenuineProblems([bug({ rubric: rubric('unscored', null, 'budget exhausted') })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].blocking).toBe(false);
        expect(res.notVerified).toHaveLength(1);
        expect(res.notVerified[0].rubric.reason).toBe('budget exhausted');
        expect(res.stats.notVerified).toBe(1);
        expect(res.stats.kept).toBe(0);
    });

    it('keeps a bypassed (deterministic) finding', () => {
        const res = filterGenuineProblems([bug({ source: 'static', rubric: rubric('bypassed') })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].blocking).toBe(true);
    });

    it('treats a model finding with no rubric as not-verified, never as passed', () => {
        const res = filterGenuineProblems([bug()], { minRubricScore: 80 });
        expect(res.notVerified).toHaveLength(1);
        expect(res.notVerified[0].rubric.status).toBe('unscored');
        expect(res.notVerified[0].rubric.reason).toMatch(/not scored/);
    });

    it('treats a deterministic finding with no rubric as bypassed', () => {
        const res = filterGenuineProblems([bug({ source: 'static' })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].blocking).toBe(true);
        expect(res.notVerified).toHaveLength(0);
    });

    it('still applies the structural checks before the rubric', () => {
        const res = filterGenuineProblems([bug({ evidence: '', _evidence: null, rubric: rubric('scored', 100) })], { minRubricScore: 80 });
        expect(res.findings).toHaveLength(0);
        expect(res.dropped[0]._precisionDrop).toBe('missing-changed-code-evidence');
    });

    it('legacy mode (no minRubricScore) is unchanged: low confidence is dropped', () => {
        const res = filterGenuineProblems([bug({ confidence: 0.3, rubric: rubric('scored', 99) })]);
        expect(res.findings).toHaveLength(0);
        expect(res.dropped[0]._precisionDrop).toBe('confidence');
        expect(res.notVerified).toEqual([]);
    });
});

describe('buildPrecisionAnalysis — rubric mode', () => {
    it('counts only verified findings and names the not-verified ones', () => {
        const text = buildPrecisionAnalysis(
            [bug({ rubric: rubric('scored', 90) }), bug({ line: 50, rubric: rubric('unscored') })],
            { minRubricScore: 80 },
        );
        expect(text).toMatch(/^## 1 genuine problem found/);
        expect(text).toMatch(/at least 80/);
        expect(text).toMatch(/1 more candidate .*Not verified/);
    });

    it('reports a clean review when every finding is unverified', () => {
        const text = buildPrecisionAnalysis([bug({ rubric: rubric('unscored') })], { minRubricScore: 80 });
        expect(text).toMatch(/^## Clean review/);
        expect(text).toMatch(/Not verified/);
    });
});

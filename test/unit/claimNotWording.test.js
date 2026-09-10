/**
 * P1-2 — wording and model scores are not proof, in either direction.
 *
 * Two failures, opposite signs, same root cause: the gate judged findings by
 * words rather than by claims.
 *
 *   RECALL. `NON_PROBLEM_TEXT` matched anywhere in title + description +
 *   message + suggestion. A high-severity authorization-bypass finding with
 *   evidence, confidence 0.99 and model score 9 passed the gate; adding "add a
 *   test for this bypass" to its description erased it as `review-commentary`.
 *
 *   PRECISION. A nonempty evidence string plus a high confidence read as proof.
 *   Nothing checked that the quoted evidence existed.
 */
const {
    classifyClaim,
    claimTextOf,
    assertsDefect,
    validationStatusOf,
} = require('../../src/utils/findingClaim.js');
const { filterGenuineProblems } = require('../../src/utils/genuineProblemGate.js');
const { quotedEvidenceStatus, assessFinding, EVIDENCE } = require('../../src/utils/findingEvidence.js');

/** A real bug: concrete, evidence-backed, model-scored. */
const realBug = (over = {}) => ({
    file: 'src/auth.js',
    line: 12,
    severity: 'high',
    category: 'security',
    title: 'Authorization check is bypassed for a caller-supplied owner id',
    description: 'The handler trusts req.query.ownerId, so any user reads any record.',
    evidence: 'return db.get(req.query.ownerId);',
    confidence: 0.99,
    score: 9,
    scoreSource: 'model',
    source: 'llm',
    ...over,
});

describe('a claim is what a finding asserts, not the words it explains with', () => {
    it('reads the assertion and leaves the fix advice out of it', () => {
        const claim = claimTextOf({
            title: 'Null deref on empty input',
            description: 'items[0] is read before the length check. Consider adding a test for this.',
        });
        expect(claim).toMatch(/items\[0\] is read/);
        expect(claim).not.toMatch(/Consider adding a test/);
    });

    it('recognises a defect assertion', () => {
        expect(assertsDefect({ title: 'Request throws for an empty list' }).asserts).toBe(true);
        expect(assertsDefect({ title: 'This name could be clearer' }).asserts).toBe(false);
    });

    it('accepts a structured claim without needing the right vocabulary', () => {
        const structured = {
            title: 'Sorting order differs',
            actualBehavior: 'orders by id',
            expectedContract: 'the API contract specifies ordering by createdAt',
        };
        expect(assertsDefect(structured).asserts).toBe(true);
        expect(classifyClaim(structured).commentary).toBe(false);
    });
});

describe('the commentary gate no longer erases real bugs', () => {
    it('a bypass finding survives its own advice to add a test', () => {
        // THE reproduction from the audit. Identical finding, one extra
        // sentence of advice, and it used to vanish.
        const withAdvice = realBug({
            description: 'The handler trusts req.query.ownerId, so any user reads any record. Add a test for this bypass.',
            suggestion: 'Add a test covering the bypass, and check ownership before the read.',
        });
        const result = filterGenuineProblems([withAdvice]);
        expect(result.findings).toHaveLength(1);
        expect(result.dropped).toHaveLength(0);
    });

    it('survives paraphrasing that mentions maintainability and TODOs', () => {
        const paraphrased = realBug({
            description: 'Any user reads any record because ownerId is unvalidated. There is a TODO nearby about maintainability.',
        });
        expect(filterGenuineProblems([paraphrased]).findings).toHaveLength(1);
    });

    it('a functional defect in a testing-CATEGORY finding is not erased by the category', () => {
        const testCategoryDefect = realBug({
            category: 'testing',
            title: 'The new fixture leaks a database connection between tests',
            description: 'setUp opens a pool and nothing closes it, so the suite exhausts connections and fails.',
        });
        expect(filterGenuineProblems([testCategoryDefect]).findings).toHaveLength(1);
    });

    it('a pure test request is still filtered', () => {
        const request = realBug({
            severity: 'high',
            category: 'general',
            title: 'No tests cover the new pricing branch',
            description: 'This diff adds a discount branch and no test exercises it.',
        });
        const result = filterGenuineProblems([request]);
        expect(result.findings).toHaveLength(0);
        expect(result.dropped[0]._precisionDrop).toBe('review-commentary');
    });

    it('a style comment is still filtered', () => {
        const style = realBug({
            severity: 'high',
            category: 'general',
            title: 'Prefer camelCase for this variable name',
            description: 'The naming here does not match the surrounding code style.',
        });
        expect(filterGenuineProblems([style]).findings).toHaveLength(0);
    });

    it('records WHY something was called commentary', () => {
        const result = filterGenuineProblems([realBug({
            severity: 'high', category: 'style', title: 'Formatting', description: 'reformat this',
        })]);
        expect(result.dropped[0]._claimReason).toMatch(/commentary category: style/);
    });
});

describe('confidence is not evidence', () => {
    const patch = '@@ -10,3 +10,4 @@\n context();\n+  const owner = req.query.ownerId;\n+  return db.get(owner);\n more();';

    const source = [
        'export function handler(req) {',
        '  const owner = req.query.ownerId;',
        '  return db.get(owner);',
        '}',
    ].join('\n');

    it('a fabricated quote is refuted against SOURCE, whatever the confidence says', () => {
        const madeUp = {
            file: 'src/auth.js', line: 11, confidence: 0.99, score: 10,
            title: 'Bypass', evidence: 'if (session.role === "superuser") { allowEverything(); }',
        };
        // Decisive: we had the file and the quote is in none of it.
        expect(quotedEvidenceStatus(madeUp, patch, source)).toBe('fabricated');
        const verdict = assessFinding(madeUp, patch, source);
        expect(verdict.verdict).toBe(EVIDENCE.REFUTED);
        expect(verdict.reason).toMatch(/does not appear anywhere in this file/);
    });

    it('with only the diff, a quote missing from the cited line is still refuted', () => {
        // Weaker position, still provable: the model pointed at a line this
        // diff shows and quoted something that is not there.
        const madeUp = {
            file: 'src/auth.js', line: 11, confidence: 0.99,
            title: 'Bypass', evidence: 'if (session.role === "superuser") { allowEverything(); }',
        };
        expect(quotedEvidenceStatus(madeUp, patch)).toBe('unverified');
        expect(assessFinding(madeUp, patch).verdict).toBe(EVIDENCE.REFUTED);
    });

    it('a correct quote of the ENCLOSING function is not called fabricated', () => {
        // The direction diff-only checking got wrong: real code, correctly
        // cited, simply outside the changed hunk.
        const enclosing = { file: 'src/auth.js', line: 11, evidence: 'export function handler(req) {' };
        expect(quotedEvidenceStatus(enclosing, patch, source)).toBe('matched');
        expect(assessFinding(enclosing, patch, source).verdict).not.toBe(EVIDENCE.REFUTED);
    });

    it('without the file, an unmatched quote outside the diff is unverified, not an invention', () => {
        // "Not in this diff" says nothing about whether the quote is real.
        const elsewhere = { file: 'src/auth.js', line: 900, evidence: 'export function handler(req) {' };
        expect(quotedEvidenceStatus(elsewhere, patch)).toBe('unverified');
    });

    it('a real quote matches even when reformatted', () => {
        const quoted = { file: 'src/auth.js', line: 11, evidence: 'return db.get(owner);' };
        expect(quotedEvidenceStatus(quoted, patch)).toBe('matched');
        expect(assessFinding(quoted, patch).verdict).not.toBe(EVIDENCE.REFUTED);
    });

    it('a scanner rule id in the evidence field is not treated as a code quote', () => {
        // Deterministic tools put a rule id or tool message here. Refuting
        // those as fabricated code would delete real findings over a field
        // that never purported to be a citation.
        expect(quotedEvidenceStatus({ evidence: 'from-scanner' }, patch)).toBe('absent');
        expect(quotedEvidenceStatus({ evidence: 'CWE-89' }, patch)).toBe('absent');
    });

    it('labels what actually backs each accepted finding', () => {
        const result = filterGenuineProblems([realBug()]);
        expect(result.findings[0].validationStatus).toBe('evidence-quoted');
        expect(result.stats.byValidation['evidence-quoted']).toBe(1);
    });

    it('a matched citation is labelled as source-validated, and no higher', () => {
        const validated = { ...realBug(), _evidence: { citedLine: 'return db.get(owner);' } };
        expect(validationStatusOf(validated)).toBe('source-validated');
        // Deliberately not "proven": the line exists, which says nothing about
        // reachability or consequence.
        expect(validationStatusOf(validated)).not.toMatch(/proven/);
    });

    it('a 0.99 confidence cannot make an unvalidated claim look validated', () => {
        const unvalidated = { title: 'Bypass', confidence: 0.99, score: 10, scoreSource: 'model' };
        expect(validationStatusOf(unvalidated)).toBe('unvalidated');
    });
});

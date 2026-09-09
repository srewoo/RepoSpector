/**
 * A realistic LLM finding, in the exact shape the per-file prompt asks for,
 * must survive canonicalisation → verification → (scorer outage) → precision
 * gate → merge decision. Before the Phase 1 fixes it died at the precision
 * gate with `missing-changed-code-evidence` and could never block.
 */
const { toCanonicalFinding } = require('../../src/services/reviewSchema.js');
const { FindingVerificationService } = require('../../src/services/FindingVerificationService.js');
const { filterGenuineProblems } = require('../../src/utils/genuineProblemGate.js');
const { decideFailure } = require('../../src/utils/failLevel.js');

const patch = [
    '@@ -10,3 +10,4 @@ function load(req) {',
    '   const id = req.params.id;',
    '-  return db.get(id);',
    '+  const owner = req.query.ownerId;',
    '+  return db.get(owner);',
    ' }',
].join('\n');
const prData = { files: [{ filename: 'src/auth.js', patch }] };

const modelOutput = {
    id: 'F1', file: 'src/auth.js', line: 12, severity: 'critical', type: 'security',
    title: 'Authorization trusts a caller-supplied owner id',
    description: 'db.get(owner) trusts req.query.ownerId so any user can read any record.',
    impact: 'IDOR', suggestion: 'Use the authenticated user id', confidence: 0.95,
};

describe('LLM finding survives the shipped post-processing chain', () => {
    it('with the scorer succeeding', async () => {
        const canonical = toCanonicalFinding({ ...modelOutput, source: 'llm' }, { phase: 'deep' });
        const verifier = new FindingVerificationService({ llmService: null });
        const v = await verifier.verify([canonical], { prData, settings: {}, llmRefutation: false });
        expect(v.findings).toHaveLength(1);

        const scored = v.findings.map(f => ({ ...f, score: 9, scoreSource: 'model' }));
        const g = filterGenuineProblems(scored, { minConfidence: 0.8, minScore: 7 });
        expect(g.findings).toHaveLength(1);

        const d = decideFailure(g.findings, { failLevel: 'high' });
        expect(d.reviewEvent).toBe('REQUEST_CHANGES');
    });

    it('with the scorer refused (budget floor)', async () => {
        const canonical = toCanonicalFinding({ ...modelOutput, source: 'llm' }, { phase: 'deep' });
        const verifier = new FindingVerificationService({ llmService: null });
        const v = await verifier.verify([canonical], { prData, settings: {}, llmRefutation: false });
        const unscored = v.findings.map(f => ({ ...f, score: 5, scoreSource: 'default' }));
        const g = filterGenuineProblems(unscored, { minConfidence: 0.8, minScore: 7 });
        expect(g.findings).toHaveLength(1);
        expect(g.findings[0]._scoreUnavailable).toBe(true);
    });
});

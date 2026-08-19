/**
 * Escalation — "the diff cannot settle this, a human must decide".
 *
 * The reason this needed a first-class representation rather than a low
 * confidence score: every stage of the pipeline is built to suppress findings it
 * cannot substantiate, which is right for defect claims and exactly wrong for
 * open questions. An escalation modelled as a weak finding gets refuted by the
 * verifier, then filtered by the severity floor, and the question is never
 * asked. These tests pin each of those escape hatches.
 */
const {
    toCanonicalFinding,
    rollupVerdict,
    buildVerdictReport,
    VERDICT,
    SEVERITY,
    EXPERTISE,
} = require('../../src/services/reviewSchema.js');
const {
    partitionForPosting,
    renderEscalationSection,
} = require('../../src/utils/reviewPostingPolicy.js');
const { FindingVerificationService } = require('../../src/services/FindingVerificationService.js');

describe('reviewSchema — escalation shape', () => {
    it('lifts an escalated finding with its expertise and reason', () => {
        const f = toCanonicalFinding({
            file: 'src/pay.js',
            line: 12,
            severity: 'medium',
            title: 'Refund path may double-credit',
            needsHumanReview: true,
            expertise: 'product',
            escalationReason: 'Whether a partial refund should re-credit loyalty points is a product decision.',
        });

        expect(f.needsHumanReview).toBe(true);
        expect(f.escalation.expertise).toBe(EXPERTISE.PRODUCT);
        expect(f.escalation.reason).toMatch(/product decision/);
    });

    it('leaves ordinary findings unescalated', () => {
        const f = toCanonicalFinding({ file: 'a.js', line: 1, title: 'off by one' });
        expect(f.needsHumanReview).toBe(false);
        expect(f.escalation).toBeNull();
    });

    it('falls back to domain expertise rather than dropping an unknown value', () => {
        const f = toCanonicalFinding({ file: 'a.js', needsHumanReview: true, expertise: 'astrology' });
        expect(f.escalation.expertise).toBe(EXPERTISE.DOMAIN);
    });

    it('falls back to the suggestion text when no reason is given', () => {
        const f = toCanonicalFinding({
            file: 'a.js', needsHumanReview: true, suggestion: 'confirm with the payments team',
        });
        expect(f.escalation.reason).toBe('confirm with the payments team');
    });

    it('is idempotent, so re-lifting does not lose the escalation', () => {
        const once = toCanonicalFinding({ file: 'a.js', needsHumanReview: true, expertise: 'security' });
        const twice = toCanonicalFinding(once);
        expect(twice.needsHumanReview).toBe(true);
        expect(twice.escalation.expertise).toBe(EXPERTISE.SECURITY);
    });
});

describe('reviewSchema — verdict', () => {
    it('does not approve a PR that has an open question', () => {
        // "I could not tell" is not "looks good".
        const verdict = rollupVerdict([
            { severity: SEVERITY.NITPICK, needsHumanReview: false },
            { severity: SEVERITY.NITPICK, needsHumanReview: true },
        ]);
        expect(verdict).toBe(VERDICT.NEEDS_DISCUSSION);
    });

    it('does not let an escalation block, either', () => {
        // The reviewer is not claiming something is wrong.
        const verdict = rollupVerdict([{ severity: SEVERITY.NITPICK, needsHumanReview: true }]);
        expect(verdict).not.toBe(VERDICT.BLOCK);
    });

    it('still blocks when a real blocking finding is present alongside one', () => {
        const verdict = rollupVerdict([
            { severity: SEVERITY.BLOCKING, needsHumanReview: false },
            { severity: SEVERITY.NITPICK, needsHumanReview: true },
        ]);
        expect(verdict).toBe(VERDICT.BLOCK);
    });

    it('still approves a genuinely clean PR', () => {
        expect(rollupVerdict([{ severity: SEVERITY.NITPICK, needsHumanReview: false }]))
            .toBe(VERDICT.APPROVE);
        expect(rollupVerdict([])).toBe(VERDICT.APPROVE);
    });

    it('surfaces escalations in the report and counts them', () => {
        const report = buildVerdictReport({
            findings: [
                { file: 'a.js', line: 1, severity: 'low', title: 'nit' },
                { file: 'b.js', line: 2, severity: 'medium', title: 'q', needsHumanReview: true, expertise: 'security' },
            ],
        });
        expect(report.escalations).toHaveLength(1);
        expect(report.escalations[0].file).toBe('b.js');
        expect(report.counts.escalations).toBe(1);
        // Derived from findings, so it cannot disagree with them.
        expect(report.findings.filter(f => f.needsHumanReview)).toHaveLength(1);
    });
});

describe('posting policy — escalations bypass the floors', () => {
    const escalation = {
        file: 'src/pay.js', line: 4, severity: 'low', title: 'needs product input',
        needsHumanReview: true, expertise: 'product',
        escalation: { expertise: 'product', reason: 'is a partial refund in scope?' },
    };

    it('survives a severity floor that would drop it as a finding', () => {
        // A repo set to `severityThreshold: high` would otherwise discard every
        // open question the reviewer raised, silently.
        const res = partitionForPosting([escalation], { severityThreshold: 'high' });
        expect(res.escalations).toHaveLength(1);
        expect(res.stats.droppedBySeverityFloor).toBe(0);
    });

    it('survives the confidence and value-score floors', () => {
        const res = partitionForPosting(
            [{ ...escalation, confidence: 0.1, score: 1 }],
            { minConfidence: 0.9, minScore: 8 },
        );
        expect(res.escalations).toHaveLength(1);
        expect(res.stats.droppedByConfidence).toBe(0);
        expect(res.stats.droppedByScore).toBe(0);
    });

    it('keeps escalations out of the defect buckets', () => {
        const res = partitionForPosting([escalation, {
            file: 'a.js', line: 9, severity: 'critical', title: 'real bug',
        }]);
        expect(res.escalations).toHaveLength(1);
        expect(res.inline.some(f => f.needsHumanReview)).toBe(false);
        expect(res.suggestions.some(f => f.needsHumanReview)).toBe(false);
        expect(res.nitpicks.some(f => f.needsHumanReview)).toBe(false);
        expect(res.stats.escalations).toBe(1);
        // The real bug is unaffected.
        expect(res.inline).toHaveLength(1);
    });

    it('does not count an escalation against the inline cap', () => {
        const many = Array.from({ length: 15 }, (_, i) => ({
            file: 'a.js', line: i + 1, severity: 'critical', title: `bug ${i}`,
        }));
        const res = partitionForPosting([...many, escalation], { maxInline: 15 });
        expect(res.inline).toHaveLength(15);
        expect(res.stats.cappedFromInline).toBe(0);
        expect(res.escalations).toHaveLength(1);
    });
});

describe('renderEscalationSection', () => {
    it('renders nothing when there is nothing to ask', () => {
        expect(renderEscalationSection([])).toBe('');
    });

    it('groups by expertise so the section doubles as routing', () => {
        const out = renderEscalationSection([
            { file: 'a.js', line: 1, escalation: { expertise: 'security', reason: 'is this token scoped?' } },
            { file: 'b.js', line: 2, escalation: { expertise: 'security', reason: 'who rotates this key?' } },
            { file: 'c.js', line: 3, escalation: { expertise: 'product', reason: 'should this be opt-in?' } },
        ]);

        expect(out).toContain('**Security**');
        expect(out).toContain('**Product**');
        expect(out).toContain('is this token scoped?');
        expect(out).toContain('who rotates this key?');
        expect(out).toContain('should this be opt-in?');
        // One heading per expertise, not one per question.
        expect(out.match(/\*\*Security\*\*/g)).toHaveLength(1);
    });

    it('says these are questions, not defects', () => {
        const out = renderEscalationSection([
            { file: 'a.js', line: 1, escalation: { expertise: 'domain', reason: 'x' } },
        ]);
        expect(out).toMatch(/open questions, not defects/i);
    });

    it('caps a pathological list', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            file: `f${i}.js`, line: i, escalation: { expertise: 'domain', reason: `q${i}` },
        }));
        const out = renderEscalationSection(many, { maxItems: 5 });
        expect(out).toContain('…and 25 more');
    });
});

describe('verification — escalations are never refuted away', () => {
    const prData = {
        files: [{ filename: 'src/pay.js', patch: '@@ -1 +1,2 @@\n+refund(order)\n+applyPoints(order)' }],
    };
    const mockLlm = () => ({ streamChat: jest.fn().mockResolvedValue({
        content: JSON.stringify({ verdicts: [] }), usage: { input: 1, output: 1 },
    }) });

    it('passes escalations through without asking the refuter about them', async () => {
        // The refuter asks "is this substantiated by the diff?". An escalation's
        // whole claim is that it is not, so it would be refuted every time —
        // deleting precisely the output that exists to say "ask a human".
        const llm = mockLlm();
        const svc = new FindingVerificationService({ llmService: llm });

        const findings = [{
            file: 'src/pay.js', line: 2, title: 'needs product input',
            description: 'Whether a partial refund re-credits points is a product call.',
            needsHumanReview: true, expertise: 'product', source: 'llm',
        }];

        const res = await svc.verify(findings, { prData, settings: {}, llmRefutation: true });

        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].needsHumanReview).toBe(true);
        const asked = JSON.stringify(llm.streamChat.mock.calls);
        expect(asked).not.toContain('needs product input');
    });

    it('still applies the deterministic hallucination gate to escalations', async () => {
        // Skipping the LLM refuter is not a licence to invent a location. A
        // question about a line that is not in the diff is as fabricated as a
        // defect claim about one, and phrasing it as a question must not launder
        // it past the mechanical check.
        const svc = new FindingVerificationService({ llmService: mockLlm() });

        const res = await svc.verify([{
            file: 'src/pay.js', line: 999, title: 'needs product input',
            needsHumanReview: true, expertise: 'product', source: 'llm',
        }], { prData, settings: {}, llmRefutation: true });

        expect(res.findings).toHaveLength(0);
        expect(res.dropped).toHaveLength(1);
    });
});

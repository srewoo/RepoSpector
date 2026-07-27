/**
 * Tests for citationEnforcer — every finding must end up cited.
 */
const { enforceCitations, hasExplicitCitation, inferRuleForFinding } = require('../../src/utils/citationEnforcer.js');

describe('citationEnforcer', () => {
    it('keeps an explicit citation as source=explicit', () => {
        const { findings, stats } = enforceCitations([
            { title: 'x', rule: 'standards/python/coding.md → PY-CODING-001' }
        ]);
        expect(findings[0].citation.source).toBe('explicit');
        expect(findings[0].rule).toMatch(/PY-CODING-001/);
        expect(stats.cited).toBe(1);
        expect(stats.inferred).toBe(0);
    });

    it('infers general/security for a CWE-tagged finding', () => {
        expect(inferRuleForFinding({ cwe: 'CWE-79', type: 'security' })).toBe('general/security');
    });

    it('infers general/correctness for a bug with no rule', () => {
        const { findings, stats } = enforceCitations([{ title: 'off-by-one', type: 'bug' }]);
        expect(findings[0].rule).toBe('general/correctness');
        expect(findings[0].citation.source).toBe('inferred');
        expect(stats.inferred).toBe(1);
    });

    it('maps performance and style types', () => {
        expect(inferRuleForFinding({ type: 'performance' })).toBe('general/performance');
        expect(inferRuleForFinding({ type: 'style' })).toBe('general/style');
    });

    it('falls back to general/correctness for unknown types', () => {
        expect(inferRuleForFinding({ type: 'totally-unknown' })).toBe('general/correctness');
    });

    it('leaves EVERY finding with a non-null rule (contract)', () => {
        const { findings } = enforceCitations([
            { title: 'a' },
            { title: 'b', type: 'security' },
            { title: 'c', rule: 'x/y' }
        ]);
        expect(findings.every(f => typeof f.rule === 'string' && f.rule.length > 0)).toBe(true);
    });

    it('hasExplicitCitation is false for empty/whitespace rule', () => {
        expect(hasExplicitCitation({ rule: '   ' })).toBe(false);
        expect(hasExplicitCitation({})).toBe(false);
        expect(hasExplicitCitation({ rule: 'general/security' })).toBe(true);
    });
});

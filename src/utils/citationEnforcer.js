/**
 * Citation enforcer.
 *
 * RepoSpector's review prompt requires every finding to carry a `Rule:` citation
 * (standards/<lang>/coding.md → RULE-ID, or general/security · general/correctness).
 * Historically that requirement was prompt-only: the LLM was *asked* to cite, but
 * nothing verified it, so uncited findings passed through unlabelled.
 *
 * This module enforces the contract on the flat finding list AFTER generation:
 *  - findings that already carry a `rule` are kept as-is (marked cited),
 *  - findings without one get a general/* rule INFERRED from their type/cwe so the
 *    finding survives (we do not silently drop real signal — dropping hurts recall),
 *  - every finding ends up with a non-null `rule` + a `citation` metadata block.
 *
 * Inference is deliberately conservative: it maps the finding's own category to the
 * closest general principle. It never invents a specific standards RULE-ID.
 */

const TYPE_TO_GENERAL_RULE = {
    security: 'general/security',
    vulnerability: 'general/security',
    secret: 'general/security',
    injection: 'general/security',
    bug: 'general/correctness',
    correctness: 'general/correctness',
    logic: 'general/correctness',
    deprecated: 'general/correctness',
    'resource-leak': 'general/correctness',
    performance: 'general/performance',
    testing: 'general/test-quality',
    test: 'general/test-quality',
    style: 'general/style',
    quality: 'general/maintainability',
    maintainability: 'general/maintainability'
};

const GENERAL_RULE_FALLBACK = 'general/correctness';

/**
 * Does this finding already carry an explicit citation?
 * @param {Object} f
 * @returns {boolean}
 */
export function hasExplicitCitation(f) {
    const r = f?.rule;
    return typeof r === 'string' && r.trim().length > 0;
}

/**
 * Infer a general/* rule for an uncited finding from its type/cwe/category.
 * @param {Object} f
 * @returns {string}
 */
export function inferRuleForFinding(f) {
    if (f?.cwe && String(f.cwe).toUpperCase().startsWith('CWE')) {
        return 'general/security';
    }
    const key = String(f?.type || f?.category || '').toLowerCase();
    if (TYPE_TO_GENERAL_RULE[key]) return TYPE_TO_GENERAL_RULE[key];
    // Partial-match fallback (e.g. "security-hotspot" → security)
    for (const [k, rule] of Object.entries(TYPE_TO_GENERAL_RULE)) {
        if (key.includes(k)) return rule;
    }
    return GENERAL_RULE_FALLBACK;
}

/**
 * Enforce that every finding carries a citation.
 * Mutates a shallow copy of each finding; returns a new array.
 *
 * @param {Array<Object>} findings - flat finding list
 * @returns {{ findings: Array<Object>, stats: { total:number, cited:number, inferred:number } }}
 */
export function enforceCitations(findings = []) {
    let cited = 0;
    let inferred = 0;

    const out = findings.map((f) => {
        if (hasExplicitCitation(f)) {
            cited++;
            return { ...f, citation: { rule: f.rule, source: 'explicit' } };
        }
        const rule = inferRuleForFinding(f);
        inferred++;
        return {
            ...f,
            rule,
            citation: { rule, source: 'inferred' }
        };
    });

    return {
        findings: out,
        stats: { total: out.length, cited, inferred }
    };
}

export default { enforceCitations, hasExplicitCitation, inferRuleForFinding };

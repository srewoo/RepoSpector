/**
 * findingClaim — what a candidate actually ASSERTS, separated from how it
 * explains itself. P1-2.
 *
 * The precision gate rejected a finding as `review-commentary` when any of four
 * blacklist regexes matched anywhere in `title + description + message +
 * suggestion` concatenated. That is a match on the explanation, not on the
 * claim. A high-severity authorization-bypass finding with evidence, confidence
 * 0.99 and model score 9 passes the gate; append "add a test for this bypass"
 * to its description and the same finding is erased as commentary. So the
 * reviewer's recall depended on the wording of its own advice.
 *
 * The fix is not a better regex. It is to ask two separate questions:
 *
 *   1. What is this finding CLAIMING?  (the title, and the assertion in the
 *      description — not the fix advice that follows it)
 *   2. Does that claim assert a defect, or is it a preference?
 *
 * A finding that asserts a defect stays a defect however it words its advice. A
 * finding whose claim IS "please add a test" or "this name is unclear" is
 * commentary however confidently it says so.
 *
 * The second half of this module is the counterweight: a confident claim is
 * still only a claim. `validationStatusOf` labels what actually backs it, so a
 * model's 0.99 can never be read downstream as proof.
 */

/**
 * Structured candidate fields.
 *
 * Producers that fill these give the gate something better than prose to judge.
 * Everything is optional and absence is never treated as a defect in itself —
 * the point is that a finding which DOES carry them can be judged on its claim
 * rather than on its vocabulary.
 */
export function toStructuredClaim(finding) {
    if (!finding || typeof finding !== 'object') return null;
    const s = finding.claim ?? finding.structured ?? finding;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = s?.[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return null;
    };
    return {
        trigger: pick('trigger', 'reproduction', 'when'),
        actualBehavior: pick('actualBehavior', 'actual', 'behavior'),
        expectedContract: pick('expectedContract', 'expected', 'contract'),
        introducedChange: pick('introducedChange', 'introducedBy', 'regressionFrom'),
        affectedConsumer: pick('affectedConsumer', 'consumer', 'caller'),
        evidenceLocations: Array.isArray(s?.evidenceLocations) ? s.evidenceLocations : [],
    };
}

/**
 * The text that carries the ASSERTION.
 *
 * `suggestion` is deliberately excluded: it is where the fix advice lives, and
 * fix advice is exactly where "add a test", "consider", "for readability" show
 * up on findings that are not about any of those things.
 *
 * The description is truncated at the first sentence boundary that introduces
 * advice ("Consider…", "You should…", "Add a test…"), for the same reason.
 */
export function claimTextOf(finding) {
    const title = String(finding?.title ?? '').trim();
    const description = String(finding?.description ?? finding?.message ?? '').trim();

    const assertion = description
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !ADVICE_OPENER.test(sentence.trim()))
        .join(' ')
        .trim();

    return [title, assertion].filter(Boolean).join('. ');
}

/** A sentence that gives advice rather than stating what is wrong. */
const ADVICE_OPENER = /^(consider|prefer|you (should|could|might)|it would be|recommend|suggest|please|add (?:a |an |more )?(test|doc)|write (?:a |an )?test|move |rename |extract |document )/i;

/**
 * Signals that a claim asserts a DEFECT — something is wrong, not merely
 * improvable. Deliberately about consequence, not about severity words: a model
 * calling something "critical" is a label, whereas "returns undefined for an
 * empty list" is a claim that can be checked.
 */
const DEFECT_ASSERTION = [
    /\b(crash(es|ed)?|throws?|panics?|segfaults?|hangs?|deadlocks?|dies|aborts?)\b/i,
    /\b(null|undefined|nil|NaN)\s+(pointer|deref\w*|reference|value|access)/i,
    /\b(returns?|yields?|produces?|writes?|reads?)\s+(the\s+)?(wrong|incorrect|stale|unescaped|unvalidated|partial|empty)\b/i,
    /\b(bypass\w*|unauthori[sz]ed|privilege escalation|injection|xss|csrf|ssrf|traversal|rce|leak(s|ed|ing)?|expos\w+)\b/i,
    /\b(race condition|data race|use[- ]after[- ]free|double free|memory leak|resource leak|infinite loop|off[- ]by[- ]one)\b/i,
    /\b(data loss|corrupt\w*|overwrite[sd]?|drops? (?:the )?(?:transaction|record|message|event))\b/i,
    /\b(breaks?|breaking change|no longer|will fail|fails? (?:when|if|for)|regress\w*)\b/i,
    /\b(unhandled|swallow(s|ed)?|silently (?:ignor\w+|fail\w+|drop\w+))\b/i,
    /\b(missing (?:await|null check|bounds check|authorization|authentication|validation|rollback|cleanup))\b/i,
];

/** Claims that ARE commentary, judged on the claim rather than on stray words. */
const COMMENTARY_CLAIM = [
    /\b(no tests?|missing tests?|not tested|test coverage|untested|add (?:a |more )?tests?)\b/i,
    /\b(naming|nam(?:e|ed) (?:is|are)|formatting|readability|code style|style guide|convention)\b/i,
    /\b(could be cleaner|more maintainable|best practice|magic number|duplicated code|dead code)\b/i,
    // Preference verbs. Only reached when no defect was asserted, so a bug
    // whose fix advice says "extract this" is unaffected — this catches the
    // comment whose entire claim IS the request.
    /\b(rename|renaming|reword|reorder|reformat|tidy|simplify|refactor|extract (?:this|it|into|to)|move (?:this|it) (?:to|into))\b/i,
    /\b(todo|fixme)\b/i,
];

/**
 * Categories whose findings are usually commentary. Usually, not always: a
 * `testing`-categorised finding that asserts the test suite now passes on a
 * broken build is a defect, and the category alone must not erase it.
 */
export const COMMENTARY_CATEGORIES = new Set([
    'style', 'lint', 'naming', 'formatting', 'documentation', 'docs',
    'maintainability', 'conventions', 'coverage', 'testing', 'test',
    'quality', 'best-practice',
]);

/**
 * Does this finding assert a defect?
 *
 * @returns {{asserts: boolean, why: string|null}}
 */
export function assertsDefect(finding) {
    const structured = toStructuredClaim(finding);
    // A candidate that filled in what breaks and what the contract was has made
    // a checkable assertion, whatever vocabulary it used.
    if (structured?.actualBehavior && structured?.expectedContract) {
        return { asserts: true, why: 'structured-claim' };
    }

    const claim = claimTextOf(finding);
    for (const re of DEFECT_ASSERTION) {
        if (re.test(claim)) return { asserts: true, why: 'defect-assertion' };
    }
    return { asserts: false, why: null };
}

/**
 * Is this finding optional commentary?
 *
 * Commentary requires BOTH that the claim reads as commentary AND that the
 * finding asserts no defect. That conjunction is the whole fix: a real bug
 * mentioning testing, TODOs or maintainability in its explanation is no longer
 * erased, and a pure test request is still filtered.
 *
 * @returns {{commentary: boolean, reason: string|null}}
 */
export function classifyClaim(finding) {
    const defect = assertsDefect(finding);
    if (defect.asserts) return { commentary: false, reason: null, assertion: defect.why };

    const category = String(finding?.category ?? finding?.type ?? '').toLowerCase();
    if (COMMENTARY_CATEGORIES.has(category)) {
        return { commentary: true, reason: `commentary category: ${category}`, assertion: null };
    }

    const claim = claimTextOf(finding);
    for (const re of COMMENTARY_CLAIM) {
        if (re.test(claim)) {
            return { commentary: true, reason: 'the claim itself is a preference', assertion: null };
        }
    }
    return { commentary: false, reason: null, assertion: null };
}

/**
 * What actually backs this finding, as a label the rest of the pipeline can
 * carry without re-deriving it.
 *
 * `source-validated` means a citation was checked against the file, which
 * proves the cited line EXISTS — not that the causal claim holds. Nothing here
 * ever returns "proven"; a model's confidence contributes nothing to this
 * value, which is the point.
 */
export const VALIDATION = Object.freeze({
    SOURCE_VALIDATED: 'source-validated',
    EVIDENCE_QUOTED: 'evidence-quoted',
    UNVALIDATED: 'unvalidated',
});

export function validationStatusOf(finding) {
    if (finding?.validationStatus) return String(finding.validationStatus);
    if (finding?._evidence?.citedLine != null) return VALIDATION.SOURCE_VALIDATED;
    if (String(finding?.evidence ?? finding?.codeSnippet ?? '').trim()) {
        return VALIDATION.EVIDENCE_QUOTED;
    }
    return VALIDATION.UNVALIDATED;
}

/** One sentence a reader can act on, for a finding that was not validated. */
export function describeValidation(status) {
    switch (status) {
        case VALIDATION.SOURCE_VALIDATED:
            return 'the cited line was matched against the file (the line exists; the causal claim is not thereby proven)';
        case VALIDATION.EVIDENCE_QUOTED:
            return 'the finding quotes evidence, which was not matched against the file';
        default:
            return 'no evidence was validated for this finding';
    }
}

export default {
    toStructuredClaim,
    claimTextOf,
    assertsDefect,
    classifyClaim,
    validationStatusOf,
    describeValidation,
    COMMENTARY_CATEGORIES,
    VALIDATION,
};

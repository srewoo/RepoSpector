/**
 * lowValueGate — demote restatements that cost a reviewer's attention and return nothing.
 *
 * Measured false-positive class 6: *"A large secondary bucket of micro-performance
 * and style restatements with no functional consequence."* Counted across both
 * adjudicated corpora this shape is **13 false positives to 1 true positive** —
 * better than the 230:29 (≈8:1) base rate, so acting on it is a net gain.
 *
 * ## Demote, do not drop
 *
 * That one true positive is why nothing here deletes a finding. The class is a
 * judgment call — "this loop is redundant" is sometimes right — and a 13:1 ratio
 * is not the 22:0 that justified dropping mis-mapped static rules outright.
 *
 * So a match is marked, not removed. The posting policy uses the mark to keep
 * these out of the limited inline-comment budget, where they displace findings
 * that carry consequence; they still appear in the summary. The reviewer says
 * everything it found, and spends its scarce attention-slots on defects.
 *
 * ## Why a severity floor is part of the test
 *
 * A finding that says "redundant" AND claims high severity is usually claiming a
 * real consequence ("redundant validation means the second call runs unchecked").
 * Only low/medium restatements are demoted, so the phrasing alone cannot mute a
 * finding that is actually asserting impact.
 */

/**
 * Vocabulary of a restatement: a preference expressed about code that works.
 *
 * Every alternative here was drawn from the adjudicated false positives —
 * "Two full passes over to_concat dtypes where one suffices", "Redundant passes
 * over to_union", "Unconditional astype on categories for every input".
 */
const RESTATEMENT = /\b(redundant|unnecessary|duplicate (?:pass|passes|work|computation)|two (?:full )?passes|micro-?optimi\w*|could be simplified|simpler to|more idiomatic|prefer(?:able|red)? to|consider using|for readability|naming|style|cleaner|verbose|boilerplate)\b/i;

/**
 * Words that mean the finding is claiming a CONSEQUENCE, not a preference.
 *
 * "Redundant validation lets the second call run unchecked" is a defect report
 * that happens to use the word "redundant". Without this exemption the gate would
 * demote exactly the findings in this class that are worth reading.
 */
const CONSEQUENCE = /\b(crash|panic|corrupt\w*|data ?loss|leak|deadlock|race|security|vulnerab\w*|incorrect result|wrong (?:result|value|output)|breaks?|fails?|exception|undefined behaviou?r|infinite loop|exhaust\w*|denial of service|quadratic)\b/i;

/**
 * Complexity notation, matched separately because it ends in `)`.
 *
 * A trailing `\b` cannot match after a closing paren — there is no word boundary
 * between `)` and a space — so folding `O(n^2)` into CONSEQUENCE above silently
 * never matched, and "unnecessary copy causes O(n^2) behaviour" was demoted as a
 * style note. Caught by its own test.
 */
const COMPLEXITY = /\bO\(\s*n\s*\^?\s*2\s*\)|\bO\(n\s*log\s*n\)|\bexponential\b/i;

/** Severities at which a restatement is still just a restatement. */
const DEMOTABLE_SEVERITY = new Set(['low', 'info', 'medium', '']);

/**
 * Is this finding a low-value restatement?
 *
 * @param {object} finding
 * @returns {{lowValue: boolean, reason: string|null}}
 */
export function assessLowValue(finding) {
    const none = { lowValue: false, reason: null };

    // An escalation is a question for a human, never a style note.
    if (finding?.needsHumanReview) return none;

    // A static rule fired deterministically; its value is not a matter of tone.
    if (finding?.source === 'static') return none;

    const severity = String(finding?.severity ?? '').toLowerCase();
    if (!DEMOTABLE_SEVERITY.has(severity)) return none;

    const text = [finding?.title, finding?.description, finding?.message].filter(Boolean).join(' ');
    if (!text || !RESTATEMENT.test(text)) return none;
    if (CONSEQUENCE.test(text) || COMPLEXITY.test(text)) return none;

    const matched = text.match(RESTATEMENT)?.[0] ?? 'restatement';
    return {
        lowValue: true,
        reason:
            `reads as a preference ("${matched}") with no stated consequence at ${severity || 'unset'} severity — ` +
            `kept in the summary, but not given an inline slot`,
    };
}

/**
 * Mark low-value findings in place of dropping them.
 *
 * @param {Array<object>} findings
 * @returns {{findings: Array<object>, demoted: number}}
 */
export function markLowValue(findings = []) {
    let demoted = 0;
    const out = findings.map((f) => {
        const { lowValue, reason } = assessLowValue(f);
        if (!lowValue) return f;
        demoted += 1;
        return { ...f, _lowValue: true, _lowValueReason: reason };
    });
    return { findings: out, demoted };
}

export default { assessLowValue, markLowValue };

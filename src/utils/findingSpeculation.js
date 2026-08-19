/**
 * findingSpeculation — refute findings that describe a hypothetical, not the diff.
 *
 * This is the LARGEST measured false-positive class. From the four-adjudicator
 * pass over 272 findings (see `eval/README.md`, "What the false positives were,
 * by frequency"), class 1 is:
 *
 *     "Speculation with no triggering evidence in the diff — 'callers may pass
 *      nil', 'if other tests run in parallel', 'may not be implemented' —
 *      nothing in the hunk suggests the condition arises."
 *
 * Those three real examples share a shape, and the shape is mechanical: a HEDGE
 * ("may", "could", "might") attached to a HYPOTHETICAL TRIGGER ("callers…",
 * "if other…", "in the future") — a claim about a world the diff does not show.
 *
 * ## Why both halves are required
 *
 * A hedge alone is not speculation. "This could overflow" on a line that visibly
 * adds `a + b` is a real, well-hedged finding; reviewers hedge for politeness,
 * and refuting on hedging alone would delete careful true positives — the
 * expensive direction, per this module's neighbours.
 *
 * So the gate fires only when a hedged hypothetical is ALSO ungrounded: the
 * finding named no construct that appears on an added line. If the evidence gate
 * could point at real added code, the finding is about this diff whatever its
 * grammar, and it survives.
 *
 * ## Why it is deliberately narrow
 *
 * Trigger phrases are enumerated rather than inferred. A general "sounds
 * uncertain" classifier is exactly the judgment call that belongs to a model,
 * and models were measured doing it badly here (the retired LLM verifier passed
 * 42 of 42 findings adjudication then rejected). This file only claims what it
 * can prove from the words on the page.
 */

import { EVIDENCE } from './findingEvidence.js';

/**
 * Modal hedges. Matched with a word boundary so "maybe" and "mayor" do not count,
 * and "Could" at the start of a sentence does.
 */
const HEDGE = /\b(may|might|could|can potentially|potentially|possibly|perhaps|conceivably)\b/i;

/**
 * Hypothetical triggers — the condition the finding needs in order to bite, which
 * the diff does not show happening.
 *
 * Each entry here is derived from an observed false positive, not invented:
 *   - callers/consumers may pass …      "callers may pass nil"
 *   - if other/another/some …           "if other tests run in parallel"
 *   - may not be implemented/supported  "may not be implemented"
 */
const HYPOTHETICAL = [
    // "callers may pass nil", "a consumer could send an empty list"
    /\b(caller|callers|consumer|consumers|client|clients|user|users|someone|a future developer)\b[^.]{0,40}\b(may|might|could|can)\b/i,
    // "if other tests run in parallel", "if another goroutine holds the lock"
    /\bif\s+(an?other|other|some|any other|a future|future)\b/i,
    // "may not be implemented", "might not be supported"
    /\b(may|might|could)\s+not\s+be\b/i,
    // "in the future", "down the line", "at some point"
    /\b(in the future|down the line|at some point|later on|eventually)\b/i,
    // "if the API changes", "should the schema change"
    /\b(if|should|when)\s+the\s+\w+\s+(change|changes|changed|grows|grow)\b/i,
    // "in a multi-threaded context", "under concurrent access" — with no such code shown
    /\b(in a|under)\s+(multi-?threaded|concurrent|distributed|high[- ]load)\b/i,
];

/**
 * Phrases that mean the finding IS about the shown code, cancelling the hedge.
 *
 * "this line may leak" is hedged but anchored; "callers may leak" is not. Without
 * this exemption a reviewer's ordinary politeness reads as speculation.
 *
 * A bare "here" is deliberately NOT an anchor. It is ubiquitous filler — "callers
 * may pass nil here" is a claim about callers, not about the shown line — and
 * including it let the single clearest speculation example in the measured set
 * pass. An anchor has to name the code, not gesture at it.
 */
const ANCHORED = /\b(this line|the line above|the line below|as (written|shown)|on line \d+|the added|newly added|this call|this change|this function|this method)\b/i;

/**
 * Assess whether a finding is ungrounded speculation.
 *
 * @param {object} finding
 * @param {object} [assessment] - the {@link import('./findingEvidence.js').assessFinding} result
 *        for this finding, when the caller already has one. GROUNDED short-circuits
 *        to a pass: proof beats grammar.
 * @returns {{verdict: string, reason: string|null, trigger: string|null}}
 */
export function assessSpeculation(finding, assessment = null) {
    const pass = { verdict: EVIDENCE.UNPROVEN, reason: null, trigger: null };

    // Proof beats grammar. A finding whose named construct is present on an added
    // line is about this diff, however tentatively it is phrased.
    if (assessment?.verdict === EVIDENCE.GROUNDED) return pass;

    // An escalation's whole purpose is to raise a question the diff cannot settle.
    // Refuting it for being hypothetical would delete the one output that exists
    // to say "ask a human" — the same carve-out FindingVerificationService makes
    // for the LLM refuter.
    if (finding?.needsHumanReview) return pass;

    const claim = [finding?.title, finding?.description, finding?.message]
        .filter(Boolean)
        .join(' ');
    if (!claim) return pass;

    if (!HEDGE.test(claim)) return pass;
    if (ANCHORED.test(claim)) return pass;

    const hit = HYPOTHETICAL.find(re => re.test(claim));
    if (!hit) return pass;

    const matched = claim.match(hit)?.[0] ?? '';
    return {
        verdict: EVIDENCE.REFUTED,
        trigger: matched,
        reason:
            `the claim is hypothetical ("${matched.trim()}") and no construct it names appears on an added line — ` +
            `nothing in this diff shows the condition arising`,
    };
}

export default { assessSpeculation };

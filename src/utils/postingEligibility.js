/**
 * Posting eligibility (spec §4.3). Between review and post the PR can be
 * closed, merged or put back to draft. Re-runs the skip rules on the freshly
 * fetched PR and refuses ONLY those three: the other skip reasons (bot author,
 * docs-only, oversized, failing pipeline) were review-time decisions the user
 * already saw and chose to post through.
 */
import { evaluateSkipRules } from '../services/SkipRuleEngine.js';

const REFUSING = new Set(['pr_closed_or_merged', 'draft_pr']);

function describeRefusal(prData, gateReason) {
    if (gateReason === 'draft_pr') {
        return 'This pull request is a draft now. Nothing was posted — mark it ready for review, then post again.';
    }
    const merged = prData?.merged === true || String(prData?.state ?? '').toLowerCase() === 'merged';
    return `This pull request is ${merged ? 'merged' : 'closed'}. Nothing was posted — `
        + 'review comments on it would not reach anyone acting on the change.';
}

/**
 * @param {object|null} prData freshly re-fetched PR; null when the fetch failed
 * @returns {{eligible: boolean, reason: string|null, gateReason: string|null, unknown?: true}}
 */
export function checkPostingEligibility(prData) {
    // Fail open: a failed re-fetch is not evidence the PR closed, and posting
    // a comment is recoverable. The caller already logs the fetch failure.
    if (!prData) return { eligible: true, reason: null, gateReason: null, unknown: true };
    const gate = evaluateSkipRules(prData);
    if (gate.action === 'SKIP' && REFUSING.has(gate.reason)) {
        return { eligible: false, reason: describeRefusal(prData, gate.reason), gateReason: gate.reason };
    }
    return { eligible: true, reason: null, gateReason: null };
}

export default { checkPostingEligibility };

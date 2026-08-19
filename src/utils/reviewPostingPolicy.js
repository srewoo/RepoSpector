/**
 * reviewPostingPolicy — the gate between "findings we produced" and "comments a
 * human has to read".
 *
 * Measured motivation. On the 50-MR benchmark (`eval/results/mr-findings-*.json`)
 * the recall-prompt run emitted 69 findings with a precision lower bound of 10%.
 * Posting all 69 inline is worse than posting none: the reviewer learns to
 * collapse the bot's comments, and the 7 real findings go with them.
 *
 * Bastion's `<findings_policy>` is the fix, and it is blunt on purpose:
 *
 *   1. Blocking only. `code_feedback` carries ONLY severity=blocking.
 *   2. Suggestions and nitpicks live in the summary, under explicit
 *      `### Suggestions` / `### Nitpicks` headings — one bullet each,
 *      `path:line` plus a one-line rationale.
 *   3. Zero blocking findings → zero inline comments.
 *
 * Nothing is thrown away: a demoted finding is still reported, just in a place
 * that costs the reviewer one scroll instead of one notification.
 *
 * This module is the ONE place that decides inline-vs-summary. It is pure —
 * no I/O, no host calls — so the policy is unit-testable without a PR.
 */

import { liftEngineFindings } from '../services/engineContract.js';
import { findingPath, findingLine } from './inlineCommentFormatter.js';

/**
 * Posting severity is a three-way bucket, not the five-way display severity.
 * Producers disagree: static analysis emits critical/high/medium/low, the
 * canonical schema emits blocking/suggestion/nitpick, some LLM paths emit
 * warning/error/info. Collapse them all here.
 */
const POSTING_SEVERITY = Object.freeze({
    BLOCKING: 'blocking',
    SUGGESTION: 'suggestion',
    NITPICK: 'nitpick',
});

const TO_POSTING = {
    // canonical
    blocking: POSTING_SEVERITY.BLOCKING,
    suggestion: POSTING_SEVERITY.SUGGESTION,
    nitpick: POSTING_SEVERITY.NITPICK,
    // legacy / display
    critical: POSTING_SEVERITY.BLOCKING,
    high: POSTING_SEVERITY.BLOCKING,
    blocker: POSTING_SEVERITY.BLOCKING,
    error: POSTING_SEVERITY.BLOCKING,
    must: POSTING_SEVERITY.BLOCKING,
    medium: POSTING_SEVERITY.SUGGESTION,
    warning: POSTING_SEVERITY.SUGGESTION,
    should: POSTING_SEVERITY.SUGGESTION,
    low: POSTING_SEVERITY.NITPICK,
    info: POSTING_SEVERITY.NITPICK,
    nit: POSTING_SEVERITY.NITPICK,
};

/** Display-severity ladder, used only by the severityThreshold floor. */
const DISPLAY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

/** Canonical → display, so a `severityThreshold: high` floor can rank a
 *  canonical `blocking` finding without the caller pre-converting. */
const TO_DISPLAY = {
    blocking: 'high',
    suggestion: 'medium',
    nitpick: 'low',
    critical: 'critical',
    high: 'high',
    medium: 'medium',
    low: 'low',
    info: 'info',
    warning: 'medium',
    error: 'high',
};

/** Bucket a finding into blocking | suggestion | nitpick. */
export function postingSeverity(f) {
    const raw = String(f?.severity ?? '').toLowerCase();
    return TO_POSTING[raw] ?? POSTING_SEVERITY.SUGGESTION;
}

/** Rank a finding on the five-way display ladder (for the threshold floor). */
function displayRank(f) {
    const raw = String(f?.severity ?? '').toLowerCase();
    const display = TO_DISPLAY[raw] ?? 'medium';
    return DISPLAY_ORDER.indexOf(display);
}

/**
 * Normalize a confidence value to 0..1, or null when absent.
 * Producers emit either a 0..1 float or a 0..100 percentage.
 */
function normalizedConfidence(f) {
    const raw = f?.confidence;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
}

/**
 * Partition findings into what gets posted inline vs. what gets demoted into
 * the summary body, applying the repo-config floors on the way.
 *
 * Gate order matters. Thresholds run FIRST so a finding dropped by
 * `severityThreshold` does not reappear as a summary bullet — a floor the user
 * configured means "I don't want to see this", not "show it somewhere else".
 *
 * @param {Array<Object>} findings - any producer shape, flat or per-file nested
 * @param {Object} [options]
 * @param {string|null} [options.severityThreshold] - critical|high|medium|low|info|'all'
 * @param {number|null} [options.minConfidence] - 0..1; findings below are dropped
 * @param {number|null} [options.minScore] - 1..10 self-reflection score floor. 0 or
 *        absent disables the gate. A finding with NO score is never dropped by
 *        it — an unscored finding means the scorer did not run or did not
 *        answer, which is not evidence against the finding.
 * @param {boolean} [options.blockingOnlyInline=true] - the Bastion policy. Set
 *        false to restore the old "post everything" behaviour.
 * @param {number} [options.maxInline=15] - hard cap on inline comments
 * @returns {{
 *   inline: Array<Object>,
 *   suggestions: Array<Object>,
 *   nitpicks: Array<Object>,
 *   stats: Object
 * }}
 */
export function partitionForPosting(findings, options = {}) {
    const {
        severityThreshold = null,
        minConfidence = null,
        minScore = null,
        blockingOnlyInline = true,
        maxInline = 15,
    } = options;

    const flat = liftEngineFindings(findings || []);

    const stats = {
        total: flat.length,
        droppedBySeverityFloor: 0,
        droppedByConfidence: 0,
        droppedByScore: 0,
        demotedToSummary: 0,
        inline: 0,
        cappedFromInline: 0,
        escalations: 0,
    };

    // ── Gate 0: escalations leave the pipeline before any floor ───────────
    //
    // Every gate below filters on a claim about SEVERITY, CONFIDENCE, or VALUE.
    // An escalation makes none of those claims — it says "the diff cannot settle
    // this, a human must decide". Passing it through the severity floor would
    // delete it for not being severe enough, which is the wrong question asked
    // of the wrong output: a repo configured `severityThreshold: high` would
    // silently discard every open question the reviewer raised.
    //
    // They also get their own section rather than joining suggestions, matching
    // Three Man Team's deliberate split of Escalate-to-Architect from Must Fix
    // and Should Fix. A question mixed into a list of defects reads as a defect.
    const escalations = [];
    const gateable = [];
    for (const f of flat) {
        if (f && typeof f === 'object' && f.needsHumanReview) escalations.push(f);
        else gateable.push(f);
    }
    stats.escalations = escalations.length;

    // ── Gate 1: severity floor from .repospector.yaml ────────────────────
    const floorKey = String(severityThreshold ?? '').toLowerCase();
    const floor = (!floorKey || floorKey === 'all') ? -1 : DISPLAY_ORDER.indexOf(floorKey);

    // ── Gate 2: confidence floor ─────────────────────────────────────────
    const confFloor = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : null;

    // ── Gate 2b: self-reflection value-score floor ───────────────────────
    const rawScore = Number(minScore);
    const scoreFloor = Number.isFinite(rawScore) && rawScore > 0 ? rawScore : null;

    const kept = [];
    for (const f of gateable) {
        if (!f || typeof f !== 'object') continue;

        if (floor >= 0 && displayRank(f) < floor) {
            stats.droppedBySeverityFloor++;
            continue;
        }

        if (confFloor != null) {
            const c = normalizedConfidence(f);
            // Absent confidence is NOT a failure — most LLM findings carry none,
            // and dropping them would silently disable the LLM path entirely.
            if (c != null && c < confFloor) {
                stats.droppedByConfidence++;
                continue;
            }
        }

        // Same rule as confidence: an ABSENT score never drops a finding,
        // because "the scorer did not answer" is not evidence of worthlessness.
        if (scoreFloor != null && Number.isFinite(Number(f?.score)) && Number(f.score) < scoreFloor) {
            stats.droppedByScore++;
            continue;
        }

        kept.push(f);
    }

    // ── Gate 3: the Bastion partition ────────────────────────────────────
    const inline = [];
    const suggestions = [];
    const nitpicks = [];

    for (const f of kept) {
        const sev = postingSeverity(f);

        if (!blockingOnlyInline) {
            // Legacy behaviour: everything with a location goes inline.
            inline.push(f);
            continue;
        }

        if (sev === POSTING_SEVERITY.BLOCKING) {
            inline.push(f);
        } else if (sev === POSTING_SEVERITY.SUGGESTION) {
            suggestions.push(f);
            stats.demotedToSummary++;
        } else {
            nitpicks.push(f);
            stats.demotedToSummary++;
        }
    }

    // A blocking finding with no location can't be posted inline. Demote it to
    // the summary rather than dropping it — Bastion does the same ("if you
    // can't name a file, lift it to summary_markdown").
    const postable = [];
    for (const f of inline) {
        if (!findingPath(f) || findingLine(f) == null) {
            suggestions.push(f);
            stats.demotedToSummary++;
            continue;
        }

        // Low-value restatements never take an inline slot. Measured at 13
        // false positives to 1 true positive across both adjudicated corpora —
        // better than the ~8:1 base rate, so the class is worth acting on, but
        // not worth deleting. They still reach the author in the summary; they
        // just stop displacing findings that carry a consequence.
        if (f._lowValue) {
            suggestions.push(f);
            stats.demotedLowValue = (stats.demotedLowValue || 0) + 1;
            continue;
        }

        postable.push(f);
    }

    // Order by self-reflection score before the cap bites, so what a reviewer
    // sees inline is the most valuable subset rather than whichever findings
    // happened to come first. Unscored sort as neutral, and sort is stable, so
    // an unscored set keeps its existing order exactly.
    const scoreOf = (f) => (Number.isFinite(Number(f?.score)) ? Number(f.score) : 5);
    postable.sort((a, b) => scoreOf(b) - scoreOf(a));

    // Cap. Anything over the cap is demoted, not discarded.
    if (postable.length > maxInline) {
        const overflow = postable.splice(maxInline);
        stats.cappedFromInline = overflow.length;
        suggestions.push(...overflow);
    }

    stats.inline = postable.length;

    return { inline: postable, suggestions, nitpicks, escalations, stats };
}

// Re-exported so the many existing importers of this module keep working, and so
// "the posting policy" remains one entry point conceptually even though the
// rendering half now lives in its own file.
export {
    renderDeferredSections,
    renderEscalationSection,
    renderPolicyNote,
} from './reviewSummarySections.js';

import {
    renderDeferredSections as _renderDeferredSections,
    renderPolicyNote as _renderPolicyNote,
} from './reviewSummarySections.js';

export default {
    partitionForPosting,
    postingSeverity,
    renderDeferredSections: _renderDeferredSections,
    renderPolicyNote: _renderPolicyNote,
};

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
        blockingOnlyInline = true,
        maxInline = 15,
    } = options;

    const flat = liftEngineFindings(findings || []);

    const stats = {
        total: flat.length,
        droppedBySeverityFloor: 0,
        droppedByConfidence: 0,
        demotedToSummary: 0,
        inline: 0,
        cappedFromInline: 0,
    };

    // ── Gate 1: severity floor from .repospector.yaml ────────────────────
    const floorKey = String(severityThreshold ?? '').toLowerCase();
    const floor = (!floorKey || floorKey === 'all') ? -1 : DISPLAY_ORDER.indexOf(floorKey);

    // ── Gate 2: confidence floor ─────────────────────────────────────────
    const confFloor = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : null;

    const kept = [];
    for (const f of flat) {
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
        if (findingPath(f) && findingLine(f) != null) postable.push(f);
        else {
            suggestions.push(f);
            stats.demotedToSummary++;
        }
    }

    // Cap. Anything over the cap is demoted, not discarded.
    if (postable.length > maxInline) {
        const overflow = postable.splice(maxInline);
        stats.cappedFromInline = overflow.length;
        suggestions.push(...overflow);
    }

    stats.inline = postable.length;

    return { inline: postable, suggestions, nitpicks, stats };
}

/** One summary bullet: `path:line — headline` plus an optional rationale. */
function renderBullet(f) {
    const path = findingPath(f);
    const line = findingLine(f);
    const loc = path ? (line != null ? `\`${path}:${line}\`` : `\`${path}\``) : '_(no location)_';

    const headline = String(f.title || f.message || f.description || 'Issue')
        .split('\n')[0]
        .trim();

    // Rationale only when it says something the headline didn't.
    const detail = String(f.suggestion || f.description || f.message || '')
        .split('\n')[0]
        .trim();

    const rule = f.rule || f.ruleId;
    const ruleTag = rule ? ` \`${rule}\`` : '';

    const tail = detail && detail !== headline ? ` — ${detail}` : '';
    return `- ${loc}${ruleTag} — ${headline}${tail}`;
}

/**
 * Render the demoted findings as the `### Suggestions` / `### Nitpicks`
 * sections that get appended to the summary comment.
 *
 * Returns '' when there is nothing to render, so the caller can concatenate
 * unconditionally.
 *
 * @param {Array<Object>} suggestions
 * @param {Array<Object>} nitpicks
 * @param {Object} [options]
 * @param {number} [options.maxPerSection=40] - keeps the comment under GitHub's
 *        65 536-character body limit on pathological reviews.
 */
export function renderDeferredSections(suggestions = [], nitpicks = [], options = {}) {
    const { maxPerSection = 40 } = options;
    const out = [];

    const section = (title, items) => {
        if (!items.length) return;
        out.push('', `### ${title}`, '');
        for (const f of items.slice(0, maxPerSection)) out.push(renderBullet(f));
        if (items.length > maxPerSection) {
            out.push(`- _…and ${items.length - maxPerSection} more (see the RepoSpector panel)._`);
        }
    };

    section('Suggestions', suggestions);
    section('Nitpicks', nitpicks);

    return out.join('\n');
}

/**
 * Human-readable one-liner for the summary footer, so a reviewer can tell that
 * silence on a line is a policy decision rather than the tool missing things.
 */
export function renderPolicyNote(stats) {
    if (!stats) return '';
    const bits = [];
    if (stats.demotedToSummary) bits.push(`${stats.demotedToSummary} non-blocking finding(s) listed above rather than posted inline`);
    if (stats.droppedBySeverityFloor) bits.push(`${stats.droppedBySeverityFloor} below the configured severity floor`);
    if (stats.droppedByConfidence) bits.push(`${stats.droppedByConfidence} below the confidence floor`);
    if (stats.suppressedAsDuplicate) bits.push(`${stats.suppressedAsDuplicate} already commented on`);
    if (!bits.length) return '';
    return `<sub>Only blocking findings are posted inline — ${bits.join('; ')}.</sub>`;
}

export default { partitionForPosting, renderDeferredSections, renderPolicyNote, postingSeverity };

/**
 * failLevel — the severity at which a review stops being advice and starts
 * blocking a merge.
 *
 * RepoSpector's rule was one line in `prReviewHandlers`:
 *
 *     const blockingEvent = multiPassBlocking > 0 ? 'REQUEST_CHANGES' : null;
 *
 * That is a hardcoded policy dressed as an implementation detail. Two problems
 * with it:
 *
 *   1. A team cannot say "comment on everything, block only on security". The
 *      only lever was the severity threshold, which changes what gets REPORTED —
 *      so the only way to stop blocking on a medium finding was to hide medium
 *      findings entirely. Reporting and blocking are different decisions.
 *
 *   2. `blocking` is computed from the finding's own severity, which the model
 *      assigned. Making a merge-blocking decision from a self-declared field with
 *      no declared threshold is exactly the kind of thing that erodes trust the
 *      first time it blocks a PR over a style nit.
 *
 * reviewdog separates the two with `-fail-level`, and that is what this is.
 *
 * ── Why this belongs in an org policy ──
 *
 * "Security findings block, everything else comments" is a statement about how a
 * team ships, not a personal preference, so `failLevel` is in
 * `configPrecedence.ENFORCEABLE_KEYS` — an organization can pin it and a repo
 * cannot quietly lower it.
 */

/**
 * Severity ranks. Higher blocks more.
 *
 * `findingsFlatten.js` documents the governing principle: three severity
 * vocabularies reach the post-processing pipeline and they must ALL be
 * understood wherever severity is compared —
 *   - legacy/display  `critical` | `high`   (static analysis, adaptOrchestratorReport)
 *   - canonical       `blocking` | `suggestion` | `nitpick`
 *                     (reviewSchema.toCanonicalFinding, ReviewCrossRepoService.toFindings)
 *   - LLM prose       `error` | `blocker`   (some provider paths)
 *
 * `RANK` used to only know the legacy vocabulary, so a canonical `blocking`
 * finding — the exact shape `toCanonicalFinding` produces for LLM
 * `critical`/`high` output, and the shape cross-repo impact findings are
 * emitted in directly — hit `rank === undefined` in `findingBlocks` and was
 * silently treated as below every bar, however severe. `blocking` ranks
 * alongside `high` (NOT `critical`'s 4): `FAIL_LEVEL_DEFAULT`'s doc comment
 * below is explicit that `high` must block on exactly what
 * `multiPassBlocking > 0` blocked on before, and `countBlocking` in
 * `findingsFlatten.js` already treats `critical|high|blocking|blocker|error`
 * as one equivalence class — ranking `blocking` at 3 preserves that. The
 * `suggestion`→medium and `nitpick`/`nit`→low ranks mirror `SEVERITY_BACK`
 * in `src/background/handlers/prReviewHandlers.js` (lines 306-310), which
 * maps canonical → legacy severity (the inverse of `LEGACY_SEVERITY` in
 * `src/services/reviewSchema.js`, which maps legacy → canonical) for
 * exactly this purpose — keeping downstream severity-gating logic working
 * unchanged.
 */
const RANK = Object.freeze({
    info: 0,
    low: 1,
    nitpick: 1,
    nit: 1,
    medium: 2,
    suggestion: 2,
    high: 3,
    blocking: 3,
    blocker: 3,
    error: 3,
    critical: 4,
});

export const FAIL_LEVEL = Object.freeze({
    /** Never block. The review is advice; a human decides. */
    NONE: 'none',
    /** Block on any finding at all, whatever its severity. */
    ANY: 'any',
    INFO: 'info',
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
});

/**
 * Default. Preserves the behaviour it replaces: `blocking` findings are assigned
 * `high`/`critical` severity, so `high` blocks on exactly what
 * `multiPassBlocking > 0` blocked on before. A configurable knob whose default
 * changes behaviour is a migration, not a feature.
 */
export const FAIL_LEVEL_DEFAULT = FAIL_LEVEL.HIGH;

/**
 * @param {unknown} value
 * @returns {string} a valid fail level
 */
export function normalizeFailLevel(value) {
    if (typeof value !== 'string') return FAIL_LEVEL_DEFAULT;
    const v = value.trim().toLowerCase();
    // Unrecognised falls back to the default, NOT to `none`: a typo must not
    // silently disable a team's merge gate.
    return Object.values(FAIL_LEVEL).includes(v) ? v : FAIL_LEVEL_DEFAULT;
}

/**
 * Does this finding meet the bar to block?
 *
 * `deterministic` findings — RepoSpector's own analyzers and any ingested
 * scanner report — are judged on severity alone. An LLM finding must ALSO be
 * marked blocking by the pipeline that produced it: it has already been through
 * the evidence gates and verification, and a finding that failed those has no
 * business blocking a merge however severe it claims to be.
 *
 * @param {Object} finding
 * @param {string} level - normalized fail level
 * @returns {boolean}
 */
export function findingBlocks(finding, level) {
    if (level === FAIL_LEVEL.NONE) return false;
    if (level === FAIL_LEVEL.ANY) return true;

    const bar = RANK[level];
    if (bar === undefined) return false;

    const severity = String(finding?.severity || 'medium').toLowerCase();
    const rank = RANK[severity];
    if (rank === undefined || rank < bar) return false;

    if (finding?.deterministic === true) return true;
    return finding?.blocking === true;
}

/**
 * Decide the verdict and the host review event.
 *
 * @param {Array<Object>} findings - the final, post-verification set
 * @param {Object} [opts]
 * @param {string} [opts.failLevel]
 * @returns {{
 *   level:string, blocks:boolean, blockingFindings:Array,
 *   verdict:string|null, reviewEvent:string|null, reason:string
 * }}
 */
export function decideFailure(findings = [], { failLevel = FAIL_LEVEL_DEFAULT } = {}) {
    const level = normalizeFailLevel(failLevel);

    if (level === FAIL_LEVEL.NONE) {
        return {
            level,
            blocks: false,
            blockingFindings: [],
            verdict: null,
            reviewEvent: null,
            reason: 'fail level is "none" — this review never blocks a merge',
        };
    }

    const blockingFindings = findings.filter(f => findingBlocks(f, level));

    if (!blockingFindings.length) {
        return {
            level,
            blocks: false,
            blockingFindings: [],
            verdict: null,
            reviewEvent: null,
            reason: `no finding at or above ${level}`,
        };
    }

    const bySeverity = {};
    for (const f of blockingFindings) {
        const s = String(f.severity || 'medium').toLowerCase();
        bySeverity[s] = (bySeverity[s] || 0) + 1;
    }

    return {
        level,
        blocks: true,
        blockingFindings,
        verdict: 'CHANGES_REQUESTED',
        reviewEvent: 'REQUEST_CHANGES',
        reason: `${blockingFindings.length} finding(s) at or above ${level} `
            + `(${Object.entries(bySeverity).map(([s, n]) => `${n} ${s}`).join(', ')})`,
    };
}

/**
 * One line for the review output, so the gate explains itself.
 *
 * Rendered whether or not it blocked. A gate that only speaks when it fires
 * leaves the reader guessing what would have fired.
 */
export function describeFailLevel(decision) {
    if (!decision) return '';
    if (decision.level === FAIL_LEVEL.NONE) {
        return 'Merge gate: off — findings are reported, never blocking.';
    }
    return decision.blocks
        ? `Merge gate: blocking — ${decision.reason}.`
        : `Merge gate: passed — ${decision.reason} (threshold: ${decision.level}).`;
}

export default {
    FAIL_LEVEL,
    FAIL_LEVEL_DEFAULT,
    normalizeFailLevel,
    findingBlocks,
    decideFailure,
    describeFailLevel,
};

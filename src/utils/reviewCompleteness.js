/**
 * Review completeness contract — P0-1.
 *
 * Every review path (browser orchestrator, direct multi-pass engine, API
 * worker, MCP-fed host agent) has its own way of failing to read part of a
 * change: a chunk times out, a per-file response never parses as JSON, a diff
 * budget drops hunks, a provider returns 500, credentials are missing. Before
 * this module each path recorded that in a different field — or not at all —
 * and the verdict was computed from the finding count alone. Zero findings
 * because nothing was wrong and zero findings because nothing was read were
 * the same value, and the second one shipped as `APPROVED`.
 *
 * The contract is one object, threaded end to end and merged as it goes:
 *
 *   expectedUnits      how many units (files/hunks/chunks) should be read
 *   inspectedUnits     how many actually produced a usable result
 *   failedUnits        [{ unit, reason, error }] — read attempted, no result
 *   parseFailures      units whose LLM output never parsed (see below)
 *   omissions          [{ kind, detail }] — content deliberately not sent
 *   unavailableChecks  [{ name, reason, required }] — a check could not run
 *
 * `parseFailures` is kept separate from `failedUnits` because it is the one
 * failure that looks EXACTLY like success downstream: the unit returns a
 * well-formed result object with an empty findings array, which is
 * bit-for-bit what a genuinely clean file returns.
 *
 * The single rule the rest of the codebase depends on: **only a complete run
 * may approve.** An incomplete run may still request changes — a blocking
 * defect found in code that WAS read is a real defect — but it may never
 * report an all-clear, because it does not know that it is clear.
 */

export const COMPLETENESS_VERSION = 1;

/** Verdict/event a run that could not finish reports instead of approving. */
export const INCOMPLETE_VERDICT = 'INCOMPLETE';
export const INCOMPLETE_EVENT = 'COMMENT';

const APPROVING_VERDICTS = new Set(['APPROVE', 'APPROVED', 'CLEAN', 'LGTM']);
const APPROVING_EVENTS = new Set(['APPROVE', 'APPROVED']);

function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

/**
 * Normalize any partial input into the full contract shape.
 * Never throws — a malformed caller must not be able to erase completeness
 * information, because "we lost the failure record" is itself incompleteness.
 */
export function createCompleteness(init = {}) {
    const src = init && typeof init === 'object' ? init : {};
    return {
        version: COMPLETENESS_VERSION,
        // `null` means "not declared" — an engine that cannot count its own
        // expected units is not thereby incomplete, it just cannot prove it
        // read everything by arithmetic. It is still judged on failures.
        expectedUnits: Number.isFinite(Number(src.expectedUnits)) && Number(src.expectedUnits) >= 0
            ? Math.floor(Number(src.expectedUnits))
            : null,
        inspectedUnits: toInt(src.inspectedUnits),
        failedUnits: toArray(src.failedUnits).map(normalizeFailedUnit),
        parseFailures: toInt(src.parseFailures),
        omissions: toArray(src.omissions).map(normalizeOmission),
        unavailableChecks: toArray(src.unavailableChecks).map(normalizeCheck),
    };
}

function normalizeFailedUnit(entry) {
    if (typeof entry === 'string') return { unit: entry, reason: 'failed', error: null };
    return {
        unit: entry?.unit ?? entry?.filename ?? entry?.file ?? entry?.chunk ?? null,
        reason: entry?.reason ?? (entry?.error ? 'error' : 'failed'),
        error: entry?.error ? String(entry.error) : null,
    };
}

function normalizeOmission(entry) {
    if (typeof entry === 'string') return { kind: 'omitted', detail: entry, advisory: false, file: null, count: null };
    return {
        kind: entry?.kind ?? 'omitted',
        detail: entry?.detail ?? entry?.reason ?? null,
        file: entry?.file ?? null,
        count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : null,
        // Advisory omissions are recorded and rendered but do not withdraw an
        // approval. Reserved for content the pipeline deliberately does not
        // send today and whose absence is a known, separately-tracked recall
        // limitation rather than a failure of this run (see P1-1: deletion-only
        // hunks). Everything else defaults to blocking.
        advisory: entry?.advisory === true,
    };
}

function normalizeCheck(entry) {
    if (typeof entry === 'string') return { name: entry, reason: null, required: true };
    return {
        name: entry?.name ?? entry?.check ?? 'unknown-check',
        reason: entry?.reason ?? null,
        // An optional check that could not run is worth reporting but does not
        // by itself make the review incomplete — an unavailable linter is not
        // the same as an unread file.
        required: entry?.required !== false,
    };
}

/** Fold any number of contracts (or raw partials) into one. */
export function mergeCompleteness(...parts) {
    const normalized = parts.filter(Boolean).map(createCompleteness);
    if (normalized.length === 0) return createCompleteness();

    const expectedKnown = normalized.filter((c) => c.expectedUnits != null);
    return createCompleteness({
        expectedUnits: expectedKnown.length
            ? expectedKnown.reduce((a, c) => a + c.expectedUnits, 0)
            : null,
        inspectedUnits: normalized.reduce((a, c) => a + c.inspectedUnits, 0),
        parseFailures: normalized.reduce((a, c) => a + c.parseFailures, 0),
        failedUnits: normalized.flatMap((c) => c.failedUnits),
        omissions: normalized.flatMap((c) => c.omissions),
        unavailableChecks: normalized.flatMap((c) => c.unavailableChecks),
    });
}

/**
 * Every reason this run cannot claim to have read the whole change.
 * Empty array === complete. Returned as text so callers can render it
 * without re-deriving the wording in four places.
 */
export function completenessReasons(completeness) {
    const c = createCompleteness(completeness);
    const reasons = [];

    if (c.parseFailures > 0) {
        reasons.push(
            `${c.parseFailures} review unit${c.parseFailures === 1 ? '' : 's'} produced output that could not be parsed`
            + ` (truncated or non-JSON response), so ${c.parseFailures === 1 ? 'its file was' : 'those files were'} not actually reviewed`
        );
    }
    if (c.failedUnits.length > 0) {
        const named = c.failedUnits.map((f) => f.unit).filter(Boolean).slice(0, 5);
        reasons.push(
            `${c.failedUnits.length} unit${c.failedUnits.length === 1 ? '' : 's'} failed to review`
            + (named.length ? ` (${named.join(', ')}${c.failedUnits.length > named.length ? ', …' : ''})` : '')
        );
    }
    if (c.expectedUnits != null && c.inspectedUnits < c.expectedUnits) {
        reasons.push(
            `${c.expectedUnits - c.inspectedUnits} of ${c.expectedUnits} unit(s) were never inspected`
        );
    }
    for (const o of c.omissions) {
        if (o.advisory) continue;
        reasons.push(
            `content omitted (${o.kind}${o.detail ? `: ${o.detail}` : ''}`
            + `${o.file ? ` — ${o.file}` : ''})`
        );
    }
    for (const chk of c.unavailableChecks) {
        if (chk.required) {
            reasons.push(`required check unavailable: ${chk.name}${chk.reason ? ` (${chk.reason})` : ''}`);
        }
    }
    return reasons;
}

export function isComplete(completeness) {
    return completenessReasons(completeness).length === 0;
}

/**
 * A markdown block naming what was not read. Empty string when complete, so
 * callers can append unconditionally.
 */
export function describeCompleteness(completeness) {
    const reasons = completenessReasons(completeness);
    if (reasons.length === 0) return '';
    return [
        '> ⚠️ **Incomplete review.** This review did not read the whole change:',
        ...reasons.map((r) => `> - ${r}.`),
        '>',
        '> Absence of findings in the parts that were not read is not evidence they are correct.',
    ].join('\n');
}

/**
 * The one place the "no approval from an incomplete run" rule lives.
 *
 * Blocking outcomes pass through untouched: a proven defect in code that WAS
 * read stays proven regardless of what else the run missed. Only the
 * affirmative all-clear is withdrawn.
 *
 * @param {{verdict?: string, reviewEvent?: string}} decision
 * @param {object} completeness
 * @returns {{verdict: string, reviewEvent: string, downgraded: boolean, reasons: string[]}}
 */
export function governVerdict(decision = {}, completeness = null) {
    const verdict = decision.verdict ?? null;
    const reviewEvent = decision.reviewEvent ?? null;
    const reasons = completenessReasons(completeness);

    if (reasons.length === 0) {
        return { verdict, reviewEvent, downgraded: false, reasons: [] };
    }

    const approving = APPROVING_VERDICTS.has(String(verdict ?? '').toUpperCase())
        || APPROVING_EVENTS.has(String(reviewEvent ?? '').toUpperCase());

    if (!approving) {
        return { verdict, reviewEvent, downgraded: false, reasons };
    }

    return {
        verdict: INCOMPLETE_VERDICT,
        reviewEvent: INCOMPLETE_EVENT,
        downgraded: true,
        reasons,
    };
}

export default {
    COMPLETENESS_VERSION,
    INCOMPLETE_VERDICT,
    INCOMPLETE_EVENT,
    createCompleteness,
    mergeCompleteness,
    completenessReasons,
    isComplete,
    describeCompleteness,
    governVerdict,
};

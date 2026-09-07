/**
 * callBudget — a hard ceiling on how many LLM calls one review may make.
 *
 * The pipeline's call count is a PRODUCT, not a sum: chunking multiplies review
 * units, `HunkWindower` multiplies them again for large files,
 * `MultiPassReviewEngine` adds an aggregation call, and verification, scoring
 * and follow-up each add passes over whatever survived. Every one of those
 * limits is local and reasonable; nothing bounded the product. A 60-file MR with
 * three 900-line files could quietly issue several hundred calls, and the user
 * discovers the number on their provider bill.
 *
 * pr-agent caps this explicitly (`max_ai_calls`) and degrades when the cap is
 * hit. This is that cap, with two differences:
 *
 *   1. It is enforced at ONE choke point — `LLMService.callLLM` — rather than at
 *      each call site. A budget every caller has to remember to check is a
 *      budget that leaks the first time someone adds a pass.
 *   2. Stages declare a PRIORITY. When the budget runs low, optional passes
 *      (scoring, follow-up) are refused while the passes that actually produce
 *      findings keep their allowance. A cap that starves the review itself to
 *      pay for a re-ranking pass is worse than no cap.
 *
 * Exhaustion is not an error. `tryConsume` returns false and the caller skips
 * its stage; the review completes with whatever it has and says so in the stats.
 * Throwing here would turn a cost control into an outage.
 */

/** 0 / null / undefined all mean "no ceiling". */
export const UNLIMITED = 0;

/**
 * `Error.name` carried by a refusal.
 *
 * Owned here rather than by `LLMService` because a refusal is a BUDGET fact that
 * layers below the LLM client have to recognise — `batchProcessor` must not retry
 * one, and a util importing the LLM service to ask would be a dependency the
 * wrong way round.
 */
export const BUDGET_ERROR_NAME = 'CallBudgetExceededError';

/**
 * Default ceiling, sized from what a review at the pipeline's OWN upper bound
 * actually costs. `SkipRuleEngine` reviews at most 60 files
 * (`PARTIAL_MAX_FILES`), and at that size a typical run spends:
 *
 *   ~60 per-file units + ~4 aggregations (one PER CHUNK, at 15 files/chunk)
 *   + ~7 finder lenses + ~4 scoring batches + ~15 fix batches + 1 summary  ≈  90
 *
 * 150 covers that with headroom while still refusing the runaway this exists to
 * catch: a forced-split MR (one chunk per oversized file) requests ~190.
 *
 * The previous 60 was sized from a model that had drifted from the code — it
 * counted one aggregation per REVIEW rather than per chunk, assumed a ~24-unit
 * cap that does not exist, and omitted the finder, fixes, explore and summary
 * stages entirely (up to 64 calls, more than the whole budget). The effect was
 * that a routine 40-file PR sat at ~58/60 and had its optional stages silently
 * refused. Deliberately generous — this is a runaway guard, not a rationing
 * scheme.
 */
export const DEFAULT_MAX_AI_CALLS = 150;

/** Hard bounds on the user-supplied setting. */
export const MIN_MAX_AI_CALLS = 5;
export const MAX_MAX_AI_CALLS = 500;

/**
 * Stage priorities. A stage may only spend down to its own reserve line, so a
 * low-priority pass cannot consume the allowance a later essential pass needs.
 *
 * `essential`  — produces findings. Spends the whole budget.
 * `important`  — decides whether a finding is real (verification). Leaves nothing.
 * `optional`   — improves presentation (scoring, labels, summary polish).
 *                Refused once the remaining budget drops below the floor.
 */
export const PRIORITY = Object.freeze({
    ESSENTIAL: 'essential',
    IMPORTANT: 'important',
    OPTIONAL: 'optional',
});

/**
 * Fraction of the limit held back from `optional` stages. With the default 150
 * and 0.15, an optional pass is refused with fewer than 23 calls left.
 */
const OPTIONAL_FLOOR_RATIO = 0.15;

/**
 * Coerce a user-entered value into a usable ceiling.
 *
 * Settings fields are free text, so this sees `''`, `'40'`, `'abc'` and `-1`.
 * Anything unreadable falls back to the default rather than to unlimited —
 * a typo must not silently remove the guard.
 *
 * @param {unknown} value
 * @param {number} [fallback=DEFAULT_MAX_AI_CALLS]
 * @returns {number} 0 for unlimited, else a value within [MIN, MAX]
 */
export function normalizeMaxAiCalls(value, fallback = DEFAULT_MAX_AI_CALLS) {
    if (value === UNLIMITED || value === '0') return UNLIMITED;
    if (value === null || value === undefined || value === '') return fallback;

    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return fallback;
    if (n <= 0) return UNLIMITED; // an explicit non-positive number means "off"

    return Math.min(MAX_MAX_AI_CALLS, Math.max(MIN_MAX_AI_CALLS, Math.floor(n)));
}

export class CallBudget {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.limit] - already normalized; 0 = unlimited
     * @param {Function} [opts.onRefusal] - ({stage, priority, requested, remaining}) => void
     */
    constructor({ limit = DEFAULT_MAX_AI_CALLS, onRefusal = null } = {}) {
        this.limit = normalizeMaxAiCalls(limit);
        this.used = 0;
        this.onRefusal = onRefusal;
        /** Per-stage spend, for the review stats block. */
        this.byStage = new Map();
        /** Stages that asked for calls they could not have. */
        this.refusals = [];
    }

    /** @param {Object} settings - the stored settings object */
    static fromSettings(settings = {}, opts = {}) {
        return new CallBudget({
            limit: normalizeMaxAiCalls(settings?.maxAiCalls),
            ...opts,
        });
    }

    get unlimited() {
        return this.limit === UNLIMITED;
    }

    /** Calls still available to an `essential` stage. */
    get remaining() {
        return this.unlimited ? Infinity : Math.max(0, this.limit - this.used);
    }

    get exhausted() {
        return this.remaining <= 0;
    }

    /** The floor an `optional` stage may not spend below. */
    get optionalFloor() {
        return this.unlimited ? 0 : Math.ceil(this.limit * OPTIONAL_FLOOR_RATIO);
    }

    /**
     * Calls available to a stage of the given priority — what a caller should use
     * to decide HOW MUCH work to attempt (e.g. how many batches to form), rather
     * than discovering the ceiling one refusal at a time.
     *
     * @param {string} [priority=PRIORITY.ESSENTIAL]
     * @returns {number} Infinity when unlimited
     */
    availableFor(priority = PRIORITY.ESSENTIAL) {
        if (this.unlimited) return Infinity;
        if (priority === PRIORITY.OPTIONAL) {
            return Math.max(0, this.remaining - this.optionalFloor);
        }
        return this.remaining;
    }

    /**
     * Spend `count` calls if the stage is allowed them.
     *
     * All-or-nothing on purpose: a verification batch given half its calls
     * reports half its findings as unverified, which reads as "verified clean".
     * A caller that can genuinely use a partial allowance should ask
     * `availableFor()` first and size its own batches.
     *
     * @param {number} [count=1]
     * @param {Object} [opts]
     * @param {string} [opts.stage='unknown'] - name recorded in the stats
     * @param {string} [opts.priority=PRIORITY.ESSENTIAL]
     * @returns {boolean} false when refused — skip the stage, do not throw
     */
    tryConsume(count = 1, { stage = 'unknown', priority = PRIORITY.ESSENTIAL } = {}) {
        const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;

        if (this.unlimited) {
            this._record(stage, n);
            return true;
        }

        if (n > this.availableFor(priority)) {
            const refusal = { stage, priority, requested: n, remaining: this.remaining };
            this.refusals.push(refusal);
            this.onRefusal?.(refusal);
            return false;
        }

        this.used += n;
        this._record(stage, n);
        return true;
    }

    _record(stage, n) {
        this.byStage.set(stage, (this.byStage.get(stage) || 0) + n);
    }

    /**
     * Give a call back — for a call that was budgeted and then not made (a cache
     * hit found after reserving, a stage that bailed before dispatch). Without
     * this, reserving ahead of the work would leak budget on every early return.
     */
    refund(count = 1, stage = 'unknown') {
        const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
        if (this.unlimited) return;
        this.used = Math.max(0, this.used - n);
        const prev = this.byStage.get(stage) || 0;
        this.byStage.set(stage, Math.max(0, prev - n));
    }

    /** Plain object for the review's stats block and for logging. */
    snapshot() {
        return {
            limit: this.limit,
            unlimited: this.unlimited,
            used: this.used,
            remaining: this.unlimited ? null : this.remaining,
            exhausted: this.unlimited ? false : this.exhausted,
            byStage: Object.fromEntries(this.byStage),
            refusals: this.refusals.slice(),
        };
    }

    /** One line for the review summary, or '' when nothing was constrained. */
    describeIfConstrained() {
        if (this.unlimited || !this.refusals.length) return '';
        const stages = [...new Set(this.refusals.map(r => r.stage))].join(', ');
        // The remedy is part of the message. A note that only names the skipped
        // stages tells the reader their review was cut short without telling
        // them that the ceiling is a setting they own.
        return `Call budget reached (${this.used}/${this.limit}) — skipped: ${stages}. `
            + 'Raise "Max AI calls per review" in Settings, or set it to 0 for no limit.';
    }
}

export default { CallBudget, normalizeMaxAiCalls, PRIORITY, DEFAULT_MAX_AI_CALLS, UNLIMITED, BUDGET_ERROR_NAME };

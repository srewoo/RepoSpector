/**
 * AdaptiveLearningService — per-tenant feedback loop.
 *
 * Closes the loop from FeedbackRepo (where dismissals are stored) back into
 * the review pipeline:
 *
 *   1. PRE-LLM: query the top-N dismissed (rule, category) pairs for this
 *      tenant and inject them as "previously dismissed" hints into the
 *      per-chunk system prompt. The LLM sees them and avoids re-emitting
 *      the same noise.
 *
 *   2. POST-LLM: any finding whose `rule` (or rule prefix) has been
 *      dismissed >= SUPPRESS_THRESHOLD times for this tenant is auto-
 *      filtered before persistence. Surfaces under report.meta.suppressed
 *      for observability.
 *
 * Tunables come from standards_bundle.contents.adaptive (per-tenant overrides),
 * falling back to module defaults.
 */

// DB + logger are imported lazily so the pure suppression helper is unit-
// testable without a full `npm install` of pg/pino/etc.
async function getDb() {
    const [{ pool }, { StandardsRepo }, { logger }] = await Promise.all([
        import('../db/pool.js'),
        import('../db/repositories.js'),
        import('../lib/logger.js'),
    ]);
    return { pool, StandardsRepo, logger };
}

const DEFAULTS = Object.freeze({
    LOOKBACK_DAYS: 90,           // only count dismissals in this window
    MAX_HINTS: 10,               // top-N rules surfaced to the LLM
    SUPPRESS_THRESHOLD: 3,       // dismissals before auto-filter kicks in
    SUPPRESS_RATIO: 0.7,         // OR: dismiss rate ≥ this triggers suppression
    MIN_OBSERVATIONS: 3,         // ratio only applies once we have N samples
});

export class AdaptiveLearningService {
    constructor({ tenantId, opts } = {}) {
        if (!tenantId) throw new Error('AdaptiveLearningService requires tenantId');
        this.tenantId = tenantId;
        this.opts = { ...DEFAULTS, ...(opts ?? {}) };
        this._cached = null;
    }

    /**
     * Load the tenant's per-rule stats from the database. Returns:
     *   Map<ruleId, { dismissed, accepted, total, ratio }>
     */
    async getRuleStats() {
        if (this._cached) return this._cached;
        const { pool, StandardsRepo, logger } = await getDb();

        // Override defaults from standards bundle if present.
        try {
            const std = await StandardsRepo.get(this.tenantId);
            const cfg = std?.contents?.adaptive;
            if (cfg && typeof cfg === 'object') {
                this.opts = { ...this.opts, ...cfg };
            }
        } catch (err) {
            logger.warn({ err: err.message }, 'adaptive_standards_lookup_failed');
        }

        const { rows } = await pool.query(
            `SELECT
                COALESCE((r.report -> 'findings' -> idx -> 'rule')::text, NULL) AS rule_raw,
                f.action,
                f.created_at
             FROM finding_feedback f
             JOIN mr_review r ON r.id = f.mr_review_id
             LEFT JOIN LATERAL (
                SELECT i AS idx FROM generate_series(0, jsonb_array_length(r.report -> 'findings') - 1) i
                WHERE (r.report -> 'findings' -> i ->> 'id') = f.finding_id
                LIMIT 1
             ) jx ON true
             WHERE r.tenant_id = $1
               AND f.created_at >= now() - ($2 || ' days')::interval`,
            [this.tenantId, String(this.opts.LOOKBACK_DAYS)],
        );

        const stats = new Map();
        for (const row of rows) {
            // rule_raw comes through as JSON-encoded string ("eslint:..."); strip quotes.
            const rule = row.rule_raw
                ? String(row.rule_raw).replace(/^"|"$/g, '')
                : null;
            if (!rule) continue;
            const cur = stats.get(rule) ?? { dismissed: 0, accepted: 0, edited: 0, total: 0 };
            if (row.action === 'dismiss') cur.dismissed++;
            else if (row.action === 'accept') cur.accepted++;
            else if (row.action === 'edit') cur.edited++;
            cur.total++;
            stats.set(rule, cur);
        }
        for (const v of stats.values()) {
            v.ratio = v.total > 0 ? v.dismissed / v.total : 0;
        }
        this._cached = stats;
        return stats;
    }

    /**
     * Top-N dismissed rules for the prompt hint.
     */
    async dismissedRulesForPrompt() {
        const stats = await this.getRuleStats();
        const candidates = [];
        for (const [rule, s] of stats) {
            if (s.dismissed > 0) {
                candidates.push({ rule, count: s.dismissed, ratio: s.ratio });
            }
        }
        candidates.sort((a, b) => b.count - a.count || b.ratio - a.ratio);
        return candidates.slice(0, this.opts.MAX_HINTS);
    }

    /**
     * Apply post-LLM suppression. Returns { kept, suppressed }.
     */
    async filterFindings(findings) {
        if (!Array.isArray(findings) || findings.length === 0) {
            return { kept: findings ?? [], suppressed: [] };
        }
        const stats = await this.getRuleStats();
        const kept = [];
        const suppressed = [];
        for (const f of findings) {
            const rule = f?.rule;
            const s = rule ? stats.get(rule) : null;
            if (s && shouldSuppress(s, this.opts)) {
                suppressed.push({ ...f, _suppressedBy: 'adaptive_learning', _stats: s });
            } else {
                kept.push(f);
            }
        }
        return { kept, suppressed };
    }
}

function shouldSuppress(stats, opts) {
    if (stats.dismissed >= opts.SUPPRESS_THRESHOLD) return true;
    if (stats.total >= opts.MIN_OBSERVATIONS && stats.ratio >= opts.SUPPRESS_RATIO) return true;
    return false;
}

export { shouldSuppress as _shouldSuppress };

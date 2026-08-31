/**
 * ReviewCacheService — remember the last review of a PR, and use it.
 *
 * Two distinct wins, and the second is the interesting one.
 *
 * 1. FRESH HIT. Same PR, same head SHA, nothing moved → return the stored
 *    review. Re-opening the panel on an unchanged PR should not cost the user
 *    another full review on their own API key.
 *
 * 2. STALE HIT. Same PR, head SHA moved → do NOT discard the old review.
 *    Feed the prior payload back into the next run as `<cached_review>`
 *    priming context: keep findings still applicable, drop ones the new diff
 *    resolved, add anything new. Without this, consecutive
 *    reviews of the same PR are independent rolls of the dice — a finding
 *    appears, vanishes on the next push for no visible reason, and reappears
 *    later. `IncrementalReviewService` already narrows WHICH files get re-read;
 *    this carries forward WHAT WE CONCLUDED about them.
 *
 * Key is the normalized PR URL. The head SHA lives in the payload, not the key,
 * so a lookup can answer "what did we last say, and at which revision?" — which
 * is exactly the question the stale path needs answered.
 *
 * Hard rule of the skip-rule design: a SKIP or DEFER outcome NEVER
 * touches this cache, in either direction. A draft MR that gets marked ready, or
 * a red pipeline that goes green, must produce a real review rather than
 * replaying the "skipped" note forever.
 */

const STORAGE_KEY = 'repospectorReviewCache';
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;  // 72h: long enough to span a review cycle
const DEFAULT_MAX_ENTRIES = 50;

/** Verdicts that must never be cached — see the module note. */
const UNCACHEABLE_VERDICTS = new Set(['SKIP', 'DEFER', 'SKIPPED', 'DEFERRED']);

/**
 * The verdict of a report, whichever field the producer used.
 *
 * `store` only ever read `report.verdict`, but the multi-pass handler stores its
 * `responseData`, which names the field `reviewVerdict`. So the guard above read
 * `undefined` for every real call and the "SKIP/DEFER never touches the cache"
 * hard rule was silently inert — gated runs were cached, then replayed as though
 * they were reviews. Read every field a producer actually sets.
 */
function verdictOf(report) {
    const raw = report?.verdict ?? report?.reviewVerdict ?? report?.gate?.outcome?.gateVerdict;
    return String(raw ?? '').toUpperCase();
}

/** Would `report` be refused by the cache? Exported so callers can avoid the call. */
export function isCacheableReport(report) {
    if (!report) return false;
    if (report.reviewSkipped === true) return false;
    return !UNCACHEABLE_VERDICTS.has(verdictOf(report));
}

/**
 * Normalize a PR URL into a stable cache key.
 * Strips the query string, fragment, trailing slash and casing differences in
 * the host, so the same MR reached from a search result and from the sidebar
 * resolves to one entry.
 */
export function cacheKeyForUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return null;
    try {
        const u = new URL(raw);
        const path = u.pathname.replace(/\/+$/, '');
        return `${u.host.toLowerCase()}${path}`;
    } catch {
        return raw.split(/[?#]/)[0].replace(/\/+$/, '');
    }
}

export const CACHE_STATUS = Object.freeze({
    MISS: 'miss',
    FRESH: 'fresh',   // same head SHA — reusable as-is
    STALE: 'stale',   // PR moved — usable only as priming context
});

export class ReviewCacheService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.storage] - defaults to chrome.storage.local
     * @param {number} [deps.ttlMs]
     * @param {number} [deps.maxEntries]
     */
    constructor({ storage = null, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
        this.storage = storage || (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    async _readAll() {
        if (!this.storage) return {};
        try {
            const got = await this.storage.get(STORAGE_KEY);
            const map = got?.[STORAGE_KEY];
            return (map && typeof map === 'object') ? map : {};
        } catch {
            return {};
        }
    }

    async _writeAll(map) {
        if (!this.storage) return;
        try {
            await this.storage.set({ [STORAGE_KEY]: map });
        } catch (e) {
            console.warn('[ReviewCache] Write failed:', e?.message);
        }
    }

    /**
     * Look up the last review of a PR.
     *
     * @param {string} prUrl
     * @param {string|null} headSha - current head SHA of the PR
     * @returns {Promise<{status:string, entry:Object|null, ageMs:number|null}>}
     */
    async lookup(prUrl, headSha) {
        const key = cacheKeyForUrl(prUrl);
        if (!key) return { status: CACHE_STATUS.MISS, entry: null, ageMs: null };

        const all = await this._readAll();
        const entry = all[key];
        if (!entry) return { status: CACHE_STATUS.MISS, entry: null, ageMs: null };

        const ageMs = Date.now() - (entry.createdAt || 0);
        if (ageMs > this.ttlMs) {
            // Expired outright. Not even useful as priming — the codebase has
            // most likely moved on around it.
            return { status: CACHE_STATUS.MISS, entry: null, ageMs };
        }

        // A missing SHA on either side means we cannot prove freshness. Treat as
        // stale rather than fresh: serving a possibly-outdated review as current
        // is a worse failure than paying for one more review.
        const fresh = !!headSha && !!entry.headSha && headSha === entry.headSha;

        return {
            status: fresh ? CACHE_STATUS.FRESH : CACHE_STATUS.STALE,
            entry,
            ageMs,
        };
    }

    /**
     * Store a completed review.
     *
     * @param {string} prUrl
     * @param {Object} params
     * @param {string|null} params.headSha
     * @param {Object} params.report - the VerdictReport / analysis result
     * @returns {Promise<boolean>} whether it was stored
     */
    async store(prUrl, { headSha = null, report = null } = {}) {
        const key = cacheKeyForUrl(prUrl);
        if (!key || !report) return false;

        // Never cache a short-circuit outcome.
        if (!isCacheableReport(report)) return false;

        const all = await this._readAll();
        all[key] = {
            key,
            prUrl,
            headSha,
            createdAt: Date.now(),
            payload: report,
        };

        // Evict oldest beyond the cap, and anything past its TTL while we're here.
        const cutoff = Date.now() - this.ttlMs;
        const kept = Object.values(all)
            .filter(e => (e.createdAt || 0) >= cutoff)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, this.maxEntries);

        await this._writeAll(Object.fromEntries(kept.map(e => [e.key, e])));
        return true;
    }

    /** Forget one PR's cached review. */
    async invalidate(prUrl) {
        const key = cacheKeyForUrl(prUrl);
        if (!key) return;
        const all = await this._readAll();
        if (all[key]) {
            delete all[key];
            await this._writeAll(all);
        }
    }

    async clear() {
        await this._writeAll({});
    }
}

/**
 * Render a stale cached review as priming context for the next run.
 *
 * Deliberately terse: this is a hint about continuity, not a second diff. Only
 * findings with a location survive — an unanchored finding cannot be checked
 * against the new diff, so repeating it just biases the model toward re-emitting
 * something it can no longer verify.
 *
 * @param {Object|null} entry - the cache entry from `lookup`
 * @param {Object} [options]
 * @param {number} [options.maxFindings=20]
 * @returns {string} markdown block, or '' when there is nothing useful to say
 */
export function renderPrimingContext(entry, options = {}) {
    const { maxFindings = 20 } = options;
    const payload = entry?.payload;
    if (!payload) return '';

    const findings = (payload.findings || payload.code_feedback || [])
        .filter(f => f && (f.file || f.filePath || f.relevant_file))
        .slice(0, maxFindings);

    if (!findings.length) return '';

    const lines = [
        '## Previous Review of This PR (at an earlier revision)',
        '',
        `We reviewed this PR at commit \`${(entry.headSha || 'unknown').slice(0, 8)}\` and raised the findings below.`,
        'The PR has since moved. Use this as continuity context:',
        '',
        '- **Keep** a finding that the new diff has NOT addressed — re-report it.',
        '- **Drop** a finding the new diff resolves. Do not re-report it, and do not',
        '  congratulate the author for fixing it; silence is the correct response.',
        '- **Add** anything new the latest changes introduced.',
        '',
        'Do NOT treat these as verified — they were our own output, not ground truth.',
        '',
    ];

    for (const f of findings) {
        const file = f.file || f.filePath || f.relevant_file;
        const line = f.line ?? f.line_number ?? '?';
        const sev = f.severity || 'suggestion';
        const text = String(f.title || f.message || f.suggestion || '').split('\n')[0].trim();
        lines.push(`- [${sev}] \`${file}:${line}\` — ${text}`);
    }

    return lines.join('\n');
}

export default ReviewCacheService;

/**
 * FindingCache — incremental PR-review cache keyed by hunk content hash.
 *
 * Goal: when a user re-runs a review on a PR after a new commit, only the
 * hunks that actually changed should be re-sent to the LLM. Everything else
 * is served from cache.
 *
 * Storage: chrome.storage.local under a single root key. Findings are
 * partitioned per (platform, owner, repo, prNumber). Within a partition,
 * each entry is keyed by `${file}::${hunkHash}`.
 *
 * Why chrome.storage.local rather than IndexedDB?
 *   - No new dependencies, mocked out-of-the-box in our jest setup.
 *   - Volume is small: a busy PR has ~50 files × ~5 hunks × ~5 findings.
 *     Total payload per PR is well under 1 MB, far inside the 10 MB
 *     storage.local quota.
 *   - chrome.storage.local is async and persists across SW restarts, which
 *     is what we need.
 *
 * Hash: a fast non-crypto hash (FNV-1a 32-bit) over a normalized hunk
 * string. Normalization strips trailing whitespace and collapses CRLF so
 * cosmetic diffs don't bust the cache.
 */

const ROOT_KEY = 'rs_finding_cache_v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class FindingCache {
    /**
     * @param {object} [opts]
     * @param {{ get: Function, set: Function, remove: Function }} [opts.storage]
     *   Inject a storage backend in tests; defaults to chrome.storage.local.
     * @param {() => number} [opts.now] - Clock injection for tests.
     */
    constructor(opts = {}) {
        this.storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage?.local);
        if (!this.storage) {
            throw new Error('FindingCache requires chrome.storage.local or an injected storage');
        }
        this.now = opts.now || Date.now;
        // In-memory hit/miss counters since last resetStats(). Cheap, used
        // by callers to fold cache effectiveness into TelemetryService runs.
        this._stats = { hits: 0, misses: 0, puts: 0, lookups: 0 };
    }

    /** Snapshot the in-memory counters. Does NOT reset. */
    getStats() {
        const s = this._stats;
        const total = s.hits + s.misses;
        return {
            ...s,
            hitRate: total > 0 ? s.hits / total : 0,
        };
    }

    /** Reset counters — typically called at the start of a review run. */
    resetStats() {
        this._stats = { hits: 0, misses: 0, puts: 0, lookups: 0 };
    }

    /**
     * Stable, fast hash for hunk content. FNV-1a 32-bit. Collisions are
     * possible at this size but acceptable for cache identity — a collision
     * just causes a cache hit on a different hunk, and the worst case is
     * showing slightly stale findings until the next real change.
     */
    static hashHunk(text) {
        const normalized = (text || '')
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.replace(/\s+$/, ''))
            .join('\n');
        let hash = 0x811c9dc5;
        for (let i = 0; i < normalized.length; i++) {
            hash ^= normalized.charCodeAt(i);
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    /**
     * Build the partition key for a PR. Stable across SHAs — findings are
     * keyed by hunk hash within the partition, so SHA doesn't appear here.
     */
    static prKey({ platform, owner, repo, prNumber }) {
        if (!platform || !owner || !repo || prNumber == null) {
            throw new Error('FindingCache.prKey requires platform, owner, repo, prNumber');
        }
        return `${platform}:${owner}/${repo}#${prNumber}`;
    }

    async _readRoot() {
        const result = await this._get(ROOT_KEY);
        return (result && result[ROOT_KEY]) || {};
    }

    async _writeRoot(root) {
        await this._set({ [ROOT_KEY]: root });
    }

    _get(key) {
        return new Promise((resolve, reject) => {
            try {
                const ret = this.storage.get(key, (val) => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve(val);
                });
                // If storage.get returns a promise (some backends), prefer it.
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
            } catch (e) {
                reject(e);
            }
        });
    }

    _set(items) {
        return new Promise((resolve, reject) => {
            try {
                const ret = this.storage.set(items, () => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Look up cached findings for a list of hunks.
     *
     * @param {object} prInfo - { platform, owner, repo, prNumber }
     * @param {Array<{ file: string, hunkHash: string }>} hunks
     * @returns {Promise<{ hits: Map<string, object[]>, misses: Array }>}
     *   `hits` maps `${file}::${hunkHash}` to its cached findings array.
     *   `misses` is the subset of input hunks with no cache entry.
     */
    async lookup(prInfo, hunks) {
        const root = await this._readRoot();
        const partition = root[FindingCache.prKey(prInfo)] || {};
        const cutoff = this.now() - TTL_MS;
        const hits = new Map();
        const misses = [];

        for (const h of hunks) {
            const k = `${h.file}::${h.hunkHash}`;
            const entry = partition[k];
            if (entry && entry.timestamp >= cutoff) {
                hits.set(k, entry.findings || []);
                this._stats.hits++;
            } else {
                misses.push(h);
                this._stats.misses++;
            }
        }
        this._stats.lookups++;
        return { hits, misses };
    }

    /**
     * Store findings for a single hunk.
     */
    async put(prInfo, file, hunkHash, findings) {
        const root = await this._readRoot();
        const pk = FindingCache.prKey(prInfo);
        if (!root[pk]) root[pk] = {};
        root[pk][`${file}::${hunkHash}`] = {
            findings: Array.isArray(findings) ? findings : [],
            timestamp: this.now(),
        };
        this._stats.puts++;
        await this._writeRoot(root);
    }

    /**
     * Bulk-store findings. More efficient than calling put() in a loop.
     *
     * @param {object} prInfo
     * @param {Array<{ file: string, hunkHash: string, findings: object[] }>} entries
     */
    async putMany(prInfo, entries) {
        if (!entries.length) return;
        const root = await this._readRoot();
        const pk = FindingCache.prKey(prInfo);
        if (!root[pk]) root[pk] = {};
        const ts = this.now();
        for (const e of entries) {
            root[pk][`${e.file}::${e.hunkHash}`] = {
                findings: Array.isArray(e.findings) ? e.findings : [],
                timestamp: ts,
            };
        }
        this._stats.puts += entries.length;
        await this._writeRoot(root);
    }

    /**
     * Drop the entire cache for a PR. Use after the PR is closed/merged.
     */
    async clearPR(prInfo) {
        const root = await this._readRoot();
        delete root[FindingCache.prKey(prInfo)];
        await this._writeRoot(root);
    }

    /**
     * Drop entries older than the TTL across all PRs. Cheap to call from a
     * periodic SW alarm.
     */
    async pruneExpired() {
        const root = await this._readRoot();
        const cutoff = this.now() - TTL_MS;
        let removed = 0;
        for (const pk of Object.keys(root)) {
            for (const k of Object.keys(root[pk])) {
                if ((root[pk][k]?.timestamp || 0) < cutoff) {
                    delete root[pk][k];
                    removed++;
                }
            }
            if (Object.keys(root[pk]).length === 0) delete root[pk];
        }
        await this._writeRoot(root);
        return removed;
    }
}

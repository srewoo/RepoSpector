/**
 * IncrementalReviewService — re-review only what moved since the last review.
 *
 * A PR is not reviewed once. Authors push fixes, and every peer tool (CodeRabbit,
 * Greptile, Bugbot) re-reviews on push. Re-running the full pipeline on every push
 * is what makes that expensive — on a BYOK model the user pays for it directly —
 * so this narrows the work to the files whose diff actually changed and carries
 * forward the findings for the rest.
 *
 * The signal is the per-file PATCH, not the file content. A file can be untouched
 * by the new commit yet still have a different patch (the base branch moved), and
 * in that case its previous findings may no longer be valid. Hashing the patch
 * captures exactly "would a reviewer see something different here?".
 *
 * State is persisted per PR URL in chrome.storage.local with a bounded retention
 * window, so a re-review survives the service worker being torn down between
 * pushes — which it always is.
 */

const STORAGE_KEY = 'repospectorIncrementalReviewState';
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches session retention

/** Review plan modes. */
export const REVIEW_MODE = {
    FULL: 'full',               // no usable prior state — review everything
    INCREMENTAL: 'incremental', // some files changed — review those, carry the rest
    UNCHANGED: 'unchanged',     // head SHA identical — nothing to do
};

/**
 * Stable non-cryptographic hash (FNV-1a). Patches are large and we only need
 * change detection, so this avoids pulling in WebCrypto's async surface.
 * @param {string} str
 * @returns {string}
 */
export function hashPatch(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** Map of `filename -> patch hash` for a normalized PR's files. */
export function fingerprintFiles(files = []) {
    const out = {};
    for (const f of files || []) {
        const name = f?.filename || f?.new_path || f?.path;
        if (!name) continue;
        out[name] = hashPatch(f.patch ?? f.diff ?? '');
    }
    return out;
}

export class IncrementalReviewService {
    /**
     * @param {object} [deps]
     * @param {object} [deps.storage] - chrome.storage.local-compatible
     * @param {number} [deps.maxEntries]
     * @param {number} [deps.ttlMs]
     */
    constructor({ storage, maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS } = {}) {
        this.storage = storage || (typeof chrome !== 'undefined' ? chrome?.storage?.local : null);
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
    }

    async _readAll() {
        if (!this.storage) return {};
        try {
            const res = await this.storage.get(STORAGE_KEY);
            return res?.[STORAGE_KEY] || {};
        } catch {
            return {};
        }
    }

    async _writeAll(all) {
        if (!this.storage) return;
        try {
            await this.storage.set({ [STORAGE_KEY]: all });
        } catch (e) {
            console.warn('IncrementalReview: failed to persist state:', e?.message);
        }
    }

    /** Previously recorded review state for a PR, or null. */
    async getState(prUrl) {
        if (!prUrl) return null;
        const all = await this._readAll();
        const entry = all[prUrl];
        if (!entry) return null;
        if (this.ttlMs && Date.now() - (entry.reviewedAt || 0) > this.ttlMs) return null;
        return entry;
    }

    /**
     * Record the outcome of a review so the next run can be incremental.
     * @param {string} prUrl
     * @param {object} prData
     * @param {Array<object>} findings - the authoritative (verified) finding set
     */
    async record(prUrl, prData, findings = []) {
        if (!prUrl) return;
        const all = await this._readAll();

        all[prUrl] = {
            headSha: prData?.headSha || null,
            reviewedAt: Date.now(),
            fileHashes: fingerprintFiles(prData?.files),
            // Persist findings so untouched files keep their results across pushes.
            findings: (findings || []).map(f => ({
                ...f,
                // Mark provenance so a carried finding can be shown as such and
                // never double-counted as newly discovered.
                carriedFromSha: prData?.headSha || null,
            })),
        };

        // Bound growth: drop the oldest entries beyond the cap and anything expired.
        const entries = Object.entries(all)
            .filter(([, v]) => !this.ttlMs || Date.now() - (v.reviewedAt || 0) <= this.ttlMs)
            .sort((a, b) => (b[1].reviewedAt || 0) - (a[1].reviewedAt || 0))
            .slice(0, this.maxEntries);

        await this._writeAll(Object.fromEntries(entries));
    }

    /** Forget a PR's state — used when the user forces a full re-review. */
    async clear(prUrl) {
        const all = await this._readAll();
        if (all[prUrl]) {
            delete all[prUrl];
            await this._writeAll(all);
        }
    }

    /**
     * Decide what this run needs to review.
     *
     * @param {object} prData - normalized PR data (needs .headSha and .files)
     * @param {object|null} prevState - from getState()
     * @param {object} [options] - { force }
     * @returns {{
     *   mode: string, filesToReview: Array, carriedFindings: Array,
     *   changedFiles: string[], unchangedFiles: string[],
     *   prevHeadSha: string|null, headSha: string|null,
     *   newCommits: Array, reason: string
     * }}
     */
    plan(prData, prevState, options = {}) {
        const headSha = prData?.headSha || null;
        const allFiles = prData?.files || [];

        const full = (reason) => ({
            mode: REVIEW_MODE.FULL,
            filesToReview: allFiles,
            carriedFindings: [],
            changedFiles: allFiles.map(f => f.filename).filter(Boolean),
            unchangedFiles: [],
            prevHeadSha: prevState?.headSha || null,
            headSha,
            newCommits: [],
            reason,
        });

        if (options.force) return full('forced full review');
        if (!prevState) return full('no previous review recorded');
        if (!headSha || !prevState.headSha) return full('head SHA unavailable — cannot diff safely');

        const newCommits = (prData?.commits || []).filter(c => {
            // Commits are newest-last on GitHub, newest-first on GitLab; matching
            // by SHA is order-independent. Anything after the previously reviewed
            // head is new — approximated as "not the previous head" plus position.
            return c?.sha && c.sha !== prevState.headSha;
        });

        if (headSha === prevState.headSha) {
            return {
                mode: REVIEW_MODE.UNCHANGED,
                filesToReview: [],
                carriedFindings: prevState.findings || [],
                changedFiles: [],
                unchangedFiles: allFiles.map(f => f.filename).filter(Boolean),
                prevHeadSha: prevState.headSha,
                headSha,
                newCommits: [],
                reason: 'head SHA unchanged since last review',
            };
        }

        const prevHashes = prevState.fileHashes || {};
        const currentHashes = fingerprintFiles(allFiles);

        const changedFiles = [];
        const unchangedFiles = [];
        for (const [name, hash] of Object.entries(currentHashes)) {
            if (prevHashes[name] && prevHashes[name] === hash) unchangedFiles.push(name);
            else changedFiles.push(name);
        }

        // Nothing meaningful to re-read: the SHA moved but no diff did (e.g. an
        // empty merge commit or a rebase that preserved every patch).
        if (changedFiles.length === 0) {
            return {
                mode: REVIEW_MODE.UNCHANGED,
                filesToReview: [],
                carriedFindings: prevState.findings || [],
                changedFiles: [],
                unchangedFiles,
                prevHeadSha: prevState.headSha,
                headSha,
                newCommits,
                reason: 'new commits, but no file diff changed',
            };
        }

        // Everything changed — no saving to be had, and a full review keeps the
        // cross-file aggregation honest.
        if (unchangedFiles.length === 0) {
            return { ...full('every file diff changed'), newCommits, prevHeadSha: prevState.headSha };
        }

        const changedSet = new Set(changedFiles);
        const unchangedSet = new Set(unchangedFiles);

        return {
            mode: REVIEW_MODE.INCREMENTAL,
            filesToReview: allFiles.filter(f => changedSet.has(f.filename)),
            // Carry forward only LLM findings on files whose diff is byte-identical.
            //
            // - A finding on a CHANGED file must be re-derived; it may already be fixed.
            // - STATIC findings are never carried: they are deterministic and cost no
            //   tokens, so re-deriving them every run is both cheaper to reason about
            //   and immune to going stale. Carrying them would also double-count
            //   against the fresh static pass, which always runs over the full PR.
            carriedFindings: (prevState.findings || []).filter(f => {
                if (f?.source === 'static') return false;
                const file = f?.file || f?.filePath;
                return file && unchangedSet.has(file);
            }),
            changedFiles,
            unchangedFiles,
            prevHeadSha: prevState.headSha,
            headSha,
            newCommits,
            reason: `${changedFiles.length} of ${allFiles.length} file diffs changed`,
        };
    }

    /** Human-readable line for the review narrative. */
    static describePlan(plan) {
        if (!plan) return '';
        if (plan.mode === REVIEW_MODE.UNCHANGED) {
            return `_No changes since the last review (${plan.reason}). Showing the previous result._`;
        }
        if (plan.mode === REVIEW_MODE.INCREMENTAL) {
            const short = (plan.prevHeadSha || '').slice(0, 7);
            return `_Incremental re-review since \`${short}\`: re-read ${plan.changedFiles.length} changed file(s), carried ${plan.carriedFindings.length} finding(s) forward from ${plan.unchangedFiles.length} unchanged file(s)._`;
        }
        return '';
    }
}

export default IncrementalReviewService;

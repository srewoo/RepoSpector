/**
 * TelemetryService — opt-in local-only metrics for review runs.
 *
 * What it tracks (per review run):
 *   - durationMs: wall-clock latency of the review
 *   - tokensIn / tokensOut: LLM usage
 *   - costUsd: estimated dollar cost (model-tier dependent)
 *   - findingsTotal / findingsKept: how many were emitted vs. survived
 *     filtering and dismissal — proxy for false-positive rate
 *   - dismissed: how many of those findings the user later dismissed
 *
 * Storage: chrome.storage.local. Strictly client-side; nothing leaves the
 * browser. Reading these metrics is the user's choice — surfaced via the
 * GET_TELEMETRY message handler so the popup can render a "your review
 * stats" page.
 *
 * Why opt-in? Telemetry that ships data off-device crosses a trust boundary
 * we don't want to cross by default in a review tool. Even local telemetry
 * is gated on a setting so users can run with zero retention if they prefer.
 *
 * Aggregation: rolling window of the last N runs (default 200). Old runs
 * fall off the back. p50/p95 are computed on demand from the window.
 */

const ROOT_KEY = 'rs_telemetry_v1';
const ENABLED_KEY = 'rs_telemetry_enabled';
const DEFAULT_WINDOW = 200;

export class TelemetryService {
    /**
     * @param {object} [opts]
     * @param {{ get: Function, set: Function }} [opts.storage] - injected for tests
     * @param {() => number} [opts.now] - clock injection for tests
     * @param {number} [opts.windowSize] - max runs retained (default 200)
     */
    constructor(opts = {}) {
        this.storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage?.local);
        if (!this.storage) {
            throw new Error('TelemetryService requires chrome.storage.local or an injected storage');
        }
        this.now = opts.now || Date.now;
        this.windowSize = opts.windowSize || DEFAULT_WINDOW;
    }

    _get(key) {
        return new Promise((resolve, reject) => {
            try {
                const ret = this.storage.get(key, (val) => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve(val);
                });
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
            } catch (e) { reject(e); }
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
            } catch (e) { reject(e); }
        });
    }

    async isEnabled() {
        const v = await this._get(ENABLED_KEY);
        return !!(v && v[ENABLED_KEY]);
    }

    async setEnabled(enabled) {
        await this._set({ [ENABLED_KEY]: !!enabled });
    }

    /**
     * Record a review run. No-op if telemetry is disabled.
     *
     * @param {object} run
     * @param {string} run.kind - "pr_review" | "code_review" | "explain_hunk" | ...
     * @param {number} run.durationMs
     * @param {number} [run.tokensIn]
     * @param {number} [run.tokensOut]
     * @param {number} [run.costUsd]
     * @param {number} [run.findingsTotal]
     * @param {number} [run.findingsKept]
     * @param {string} [run.model]
     */
    async record(run) {
        if (!(await this.isEnabled())) return;
        const root = await this._readRoot();
        root.runs.push({
            ts: this.now(),
            kind: String(run.kind || 'unknown'),
            durationMs: numberOr(run.durationMs, 0),
            tokensIn: numberOr(run.tokensIn, 0),
            tokensOut: numberOr(run.tokensOut, 0),
            costUsd: numberOr(run.costUsd, 0),
            findingsTotal: numberOr(run.findingsTotal, 0),
            findingsKept: numberOr(run.findingsKept, 0),
            model: run.model || null,
        });
        // Trim to the rolling window.
        if (root.runs.length > this.windowSize) {
            root.runs.splice(0, root.runs.length - this.windowSize);
        }
        await this._writeRoot(root);
    }

    /**
     * Increment the dismissed counter for the most recent run of `kind`.
     * Lets us approximate "false-positive rate" without a tight coupling
     * between the finding-card UI and a specific run id.
     */
    async recordDismissal(kind = 'pr_review') {
        if (!(await this.isEnabled())) return;
        const root = await this._readRoot();
        for (let i = root.runs.length - 1; i >= 0; i--) {
            if (root.runs[i].kind === kind) {
                root.runs[i].dismissed = (root.runs[i].dismissed || 0) + 1;
                break;
            }
        }
        await this._writeRoot(root);
    }

    /**
     * Compute summary metrics over the rolling window.
     */
    async getSummary() {
        const root = await this._readRoot();
        const runs = root.runs;
        if (runs.length === 0) {
            return {
                runs: 0,
                latency: { p50: 0, p95: 0 },
                tokens: { in: 0, out: 0 },
                costUsd: 0,
                findings: { total: 0, kept: 0, dismissed: 0, fpRate: 0 },
                byKind: {},
            };
        }
        const latencies = runs.map((r) => r.durationMs).sort((a, b) => a - b);
        const totalIn = runs.reduce((s, r) => s + (r.tokensIn || 0), 0);
        const totalOut = runs.reduce((s, r) => s + (r.tokensOut || 0), 0);
        const totalCost = runs.reduce((s, r) => s + (r.costUsd || 0), 0);
        const findTotal = runs.reduce((s, r) => s + (r.findingsTotal || 0), 0);
        const findKept = runs.reduce((s, r) => s + (r.findingsKept || 0), 0);
        const dismissed = runs.reduce((s, r) => s + (r.dismissed || 0), 0);

        const byKind = {};
        for (const r of runs) {
            const b = byKind[r.kind] || (byKind[r.kind] = { runs: 0, totalDuration: 0 });
            b.runs += 1;
            b.totalDuration += r.durationMs || 0;
        }
        for (const k of Object.keys(byKind)) {
            byKind[k].avgDuration = Math.round(byKind[k].totalDuration / byKind[k].runs);
        }

        return {
            runs: runs.length,
            latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
            tokens: { in: totalIn, out: totalOut },
            costUsd: roundCents(totalCost),
            findings: {
                total: findTotal,
                kept: findKept,
                dismissed,
                // FP proxy: dismissed / kept. Bounded into [0, 1].
                fpRate: findKept > 0 ? Math.min(1, dismissed / findKept) : 0,
            },
            byKind,
        };
    }

    async clear() {
        await this._writeRoot({ runs: [] });
    }

    async _readRoot() {
        const r = await this._get(ROOT_KEY);
        return (r && r[ROOT_KEY]) || { runs: [] };
    }

    async _writeRoot(root) {
        await this._set({ [ROOT_KEY]: root });
    }
}

// ─── private helpers ────────────────────────────────────────────────────────

function numberOr(v, fallback) {
    return typeof v === 'number' && !isNaN(v) ? v : fallback;
}

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return 0;
    // Nearest-rank method: simple, deterministic, no interpolation surprises.
    const idx = Math.min(
        sortedAsc.length - 1,
        Math.max(0, Math.ceil(p * sortedAsc.length) - 1)
    );
    return sortedAsc[idx];
}

function roundCents(usd) {
    return Math.round(usd * 100) / 100;
}

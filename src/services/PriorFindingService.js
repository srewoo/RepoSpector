/**
 * PriorFindingService — "has this been said before, and what happened?"
 *
 * pr-agent's `/similar_issue` indexes past issues in a vector DB to find related
 * discussion. The more useful version of that question for a reviewer is not
 * "which issue looks like this" but: **this exact finding was raised on this
 * exact code before — did the team accept it?**
 *
 * RepoSpector can answer that and a hosted tool cannot, because
 * `FeedbackCollectorService` already accumulates the team's own verdicts: every
 * inline comment carries a tick-box footer, and each tick becomes a ledger row
 * with `{rule, file, line, weight, reasoning, prUrl}`. That ledger is this
 * service's whole corpus. No embeddings, no extra store, no model call.
 *
 * Two things it produces:
 *
 *   1. Per-finding history — the prior verdicts on the same rule, nearest-first
 *      by location. "Rejected 3/3 times on this file, most recently with
 *      'intentional, see ADR-14'" is decisive information that
 *      `AdaptiveLearningService` currently only consumes as a confidence number,
 *      never shows to the reviewer.
 *
 *   2. A recommendation, from the counts alone. Deterministic, because a
 *      probabilistic re-read of a definite record is a downgrade.
 *
 * Read-only and fail-open: a ledger that cannot be read yields no history, and
 * the review proceeds exactly as it would have.
 */

/** Prior rows older than this are reported but never drive a recommendation. */
const STALE_MS = 120 * 24 * 60 * 60 * 1000; // 120 days

/** Consecutive rejections before "the team has settled this" is a fair claim. */
const REJECTION_THRESHOLD = 2;

export const RECOMMENDATION = Object.freeze({
    SUPPRESS: 'suppress',       // repeatedly rejected here — do not raise again
    DEPRIORITIZE: 'deprioritize', // mixed, leaning rejected
    KEEP: 'keep',               // accepted before, or no relevant history
    NONE: 'none',               // no history at all
});

export class PriorFindingService {
    /**
     * @param {Object} deps
     * @param {Object} [deps.feedbackCollector] - anything with getLedger()
     */
    constructor({ feedbackCollector = null } = {}) {
        this.feedbackCollector = feedbackCollector;
        this._ledger = null;
    }

    /** Read the ledger once per instance. Never throws. */
    async _rows(repoId = null) {
        if (this._ledger) return this._ledger;
        try {
            const all = await this.feedbackCollector?.getLedger?.();
            this._ledger = (Array.isArray(all) ? all : [])
                .filter(r => r && (!repoId || !r.repoId || r.repoId === repoId));
        } catch (e) {
            console.warn('[PriorFindings] Ledger unavailable:', e?.message);
            this._ledger = [];
        }
        return this._ledger;
    }

    /**
     * Prior verdicts for one finding.
     *
     * Matching is on RULE first, then narrowed by location. The rule is the only
     * stable identity a finding has across PRs — its title is model-written and
     * varies run to run, and its line moves with every edit to the file.
     *
     * A finding with no rule id is unmatchable. It returns no history rather than
     * falling back to fuzzy text matching, because a wrong match here is a
     * recommendation to suppress a real defect.
     *
     * @param {Object} finding
     * @param {Array} rows
     * @returns {{prior:Array, sameFile:number, accepted:number, rejected:number, recommendation:string}}
     */
    static historyFor(finding, rows = []) {
        const rule = finding?.ruleId || finding?.rule || null;
        const empty = {
            prior: [], sameFile: 0, accepted: 0, rejected: 0,
            recommendation: RECOMMENDATION.NONE,
        };
        if (!rule) return empty;

        const file = finding.filePath || finding.file || null;

        const matches = rows.filter(r => r.rule === rule);
        if (!matches.length) return empty;

        // Nearest first: same file and near the same line is the strongest
        // evidence, a different file the weakest.
        const scored = matches.map(r => {
            let proximity = 0;
            if (file && r.file === file) {
                proximity = 2;
                if (Number.isFinite(r.line) && Number.isFinite(finding.line)
                    && Math.abs(r.line - finding.line) <= 20) {
                    proximity = 3;
                }
            }
            return { row: r, proximity };
        }).sort((a, b) => (b.proximity - a.proximity) || ((b.row.collectedAt || 0) - (a.row.collectedAt || 0)));

        const now = Date.now();
        const prior = scored.map(({ row, proximity }) => ({
            prUrl: row.prUrl,
            file: row.file,
            line: row.line,
            verdict: row.weight > 0 ? 'accepted' : row.weight < 0 ? 'rejected' : 'neutral',
            reasoning: row.reasoning || null,
            when: row.collectedAt || null,
            stale: !!row.collectedAt && (now - row.collectedAt) > STALE_MS,
            sameFile: proximity >= 2,
        }));

        // Only fresh, same-file verdicts drive a recommendation. A rejection from
        // a different file is context, not precedent — the rule may be wrong
        // there and right here — and a verdict from four months ago may predate
        // the code it was about.
        const decisive = prior.filter(p => p.sameFile && !p.stale);
        const accepted = decisive.filter(p => p.verdict === 'accepted').length;
        const rejected = decisive.filter(p => p.verdict === 'rejected').length;

        let recommendation = RECOMMENDATION.KEEP;
        if (rejected >= REJECTION_THRESHOLD && accepted === 0) {
            recommendation = RECOMMENDATION.SUPPRESS;
        } else if (rejected > accepted) {
            recommendation = RECOMMENDATION.DEPRIORITIZE;
        } else if (!decisive.length) {
            // History exists, but none of it is decisive here.
            recommendation = prior.length ? RECOMMENDATION.KEEP : RECOMMENDATION.NONE;
        }

        return {
            prior,
            sameFile: prior.filter(p => p.sameFile).length,
            accepted,
            rejected,
            recommendation,
        };
    }

    /**
     * Annotate a set of findings with their history.
     *
     * ANNOTATES — never filters. Removing a finding on the strength of past
     * rejections belongs to the posting policy, which is where every other
     * suppression decision already lives and is already reported to the user.
     * A service that silently dropped findings from this data would make
     * "the review stopped mentioning X" untraceable.
     *
     * @returns {Promise<{findings:Array, stats:Object}>}
     */
    async annotate(findings = [], { repoId = null } = {}) {
        const rows = await this._rows(repoId);
        const stats = {
            ledgerRows: rows.length,
            withHistory: 0,
            suppressRecommended: 0,
            deprioritizeRecommended: 0,
        };

        if (!rows.length || !findings.length) {
            return { findings, stats };
        }

        const annotated = findings.map(f => {
            const history = PriorFindingService.historyFor(f, rows);
            if (history.recommendation === RECOMMENDATION.NONE) return f;

            stats.withHistory++;
            if (history.recommendation === RECOMMENDATION.SUPPRESS) stats.suppressRecommended++;
            if (history.recommendation === RECOMMENDATION.DEPRIORITIZE) stats.deprioritizeRecommended++;

            return { ...f, priorFindings: history };
        });

        return { findings: annotated, stats };
    }

    /**
     * Prior PRs that touched the same files as this one, most recent first.
     *
     * The reviewer's version of "who else has been here": a file this PR changes
     * that was also the subject of a rejected finding, or of three PRs last
     * month, is a file worth reading more carefully.
     *
     * @param {Object} prData
     * @param {Object} [opts]
     * @returns {Promise<Array<{prUrl:string, files:string[], verdicts:Object, lastSeen:number}>>}
     */
    async relatedPRs(prData, { repoId = null, limit = 5 } = {}) {
        const rows = await this._rows(repoId);
        if (!rows.length) return [];

        const changed = new Set((prData?.files || []).map(f => f.filename).filter(Boolean));
        if (!changed.size) return [];

        const byPr = new Map();
        for (const r of rows) {
            if (!r.prUrl || !r.file || !changed.has(r.file)) continue;
            // Never report the PR under review as related to itself.
            if (prData?.url && r.prUrl === prData.url) continue;

            if (!byPr.has(r.prUrl)) {
                byPr.set(r.prUrl, {
                    prUrl: r.prUrl,
                    files: new Set(),
                    verdicts: { accepted: 0, rejected: 0, neutral: 0 },
                    lastSeen: 0,
                });
            }
            const entry = byPr.get(r.prUrl);
            entry.files.add(r.file);
            if (r.weight > 0) entry.verdicts.accepted++;
            else if (r.weight < 0) entry.verdicts.rejected++;
            else entry.verdicts.neutral++;
            entry.lastSeen = Math.max(entry.lastSeen, r.collectedAt || 0);
        }

        return [...byPr.values()]
            .map(e => ({ ...e, files: [...e.files] }))
            // Most overlap first, then most recent — a PR that touched four of the
            // same files says more than one that touched one of them yesterday.
            .sort((a, b) => (b.files.length - a.files.length) || (b.lastSeen - a.lastSeen))
            .slice(0, limit);
    }

    /**
     * Markdown for the review output. '' when there is nothing to say, so the
     * caller can concatenate unconditionally.
     */
    static renderSection({ annotatedFindings = [], relatedPRs = [] } = {}) {
        const withHistory = annotatedFindings.filter(f => f.priorFindings?.prior?.length);
        if (!withHistory.length && !relatedPRs.length) return '';

        const lines = ['## Prior Review History', ''];

        for (const f of withHistory) {
            const h = f.priorFindings;
            const verdict = h.rejected > h.accepted ? 'rejected' : 'accepted';
            lines.push(
                `- **${f.title || f.ruleId}** — raised before on this file and ${verdict} `
                + `(${h.accepted} accepted / ${h.rejected} rejected).`
            );
            const why = h.prior.find(p => p.reasoning)?.reasoning;
            if (why) lines.push(`  - Team said: _${truncate(why, 200)}_`);
            if (h.recommendation === RECOMMENDATION.SUPPRESS) {
                lines.push('  - This team has settled this one. Consider it closed unless the code changed materially.');
            }
        }

        if (relatedPRs.length) {
            lines.push('', '**Recently reviewed alongside:**');
            for (const pr of relatedPRs) {
                lines.push(`- ${pr.prUrl} — ${pr.files.length} file(s) in common`);
            }
        }

        return lines.join('\n');
    }
}

function truncate(s, n) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export default PriorFindingService;

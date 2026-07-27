/**
 * FeedbackCollectorService — read the flywheel back in.
 *
 * `feedbackFooter.js` writes a tick-box footer onto every inline comment. This
 * service is the other half: on each review run, before any LLM spend, it reads
 * the prior bot threads off the PR, extracts which box the author ticked and
 * what they said in reply, and records a labelled example.
 *
 * That record is the only source of ground truth RepoSpector can accumulate that
 * a hosted competitor cannot copy — this team's verdicts on this team's code.
 * Two consumers use it:
 *
 *   AdaptiveLearningService — a rule rejected as a false positive three times in
 *                             a repo gets its confidence cut, so it stops being
 *                             posted inline.
 *   ConventionMiner         — "valid, will fix" replies are the team explaining
 *                             its own conventions in its own words.
 *
 * Ported from pr-agent's `pr_agent/feedback/collector.py`. Fail-open throughout:
 * every method swallows its errors and returns a zero result. A feedback outage
 * degrades learning, never the review.
 */

import { FEEDBACK_MARKER, parseFeedback, lookupOption } from '../utils/feedbackFooter.js';

const STORAGE_KEY = 'repospectorFeedbackLedger';
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

export class FeedbackCollectorService {
    /**
     * @param {Object} deps
     * @param {Object} deps.pullRequestService - needs fetchBotInlineDiscussions
     * @param {Object} [deps.adaptiveLearning] - optional AdaptiveLearningService
     * @param {Object} [deps.storage] - defaults to chrome.storage.local
     */
    constructor({ pullRequestService, adaptiveLearning = null, storage = null } = {}) {
        this.prService = pullRequestService;
        this.adaptiveLearning = adaptiveLearning;
        this.storage = storage || (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
        this.maxEntries = DEFAULT_MAX_ENTRIES;
        this.ttlMs = DEFAULT_TTL_MS;
    }

    /**
     * Collect feedback for one PR. Never throws.
     *
     * @param {string} prUrl
     * @param {Object} [options]
     * @param {string} [options.repoId] - scopes the adaptive-learning signal
     * @returns {Promise<{collected:number, rows:Array, skipped:Object}>}
     */
    async collect(prUrl, options = {}) {
        const empty = {
            collected: 0,
            rows: [],
            skipped: { noTick: 0, multiTicked: 0, unknownLabel: 0 },
        };

        try {
            if (!this.prService?.fetchBotInlineDiscussions) return empty;

            const discussions = await this.prService.fetchBotInlineDiscussions(prUrl, FEEDBACK_MARKER);
            if (!discussions?.length) return empty;

            const botAuthor = this._resolveBotAuthor(discussions);
            const rows = [];
            const skipped = { noTick: 0, multiTicked: 0, unknownLabel: 0 };

            for (const d of discussions) {
                const row = this._buildRow(d, botAuthor, prUrl, options.repoId);
                if (row === 'multi') { skipped.multiTicked++; continue; }
                if (row === 'unknown') { skipped.unknownLabel++; continue; }
                if (!row) { skipped.noTick++; continue; }
                rows.push(row);
            }

            if (rows.length) {
                await this._persist(rows);
                await this._applyToAdaptiveLearning(rows, options.repoId);
            }

            console.log(
                `📝 Feedback: ${rows.length} labelled from ${discussions.length} bot thread(s) ` +
                `(${skipped.noTick} untouched, ${skipped.multiTicked} multi-ticked, ${skipped.unknownLabel} unknown label)`
            );

            return { collected: rows.length, rows, skipped };
        } catch (e) {
            console.warn('[Feedback] Collection failed:', e?.message);
            return empty;
        }
    }

    /**
     * Identify the bot. Every thread we fetched was started by us, so the author
     * of the first bot note IS the bot — no separate identity call needed.
     */
    _resolveBotAuthor(discussions) {
        for (const d of discussions) {
            const a = d?.botNote?.author;
            if (a) return a;
        }
        return null;
    }

    /**
     * Turn one discussion into a labelled row, or a skip reason.
     * @returns {Object|'multi'|'unknown'|null}
     */
    _buildRow(discussion, botAuthor, prUrl, repoId) {
        const bot = discussion?.botNote;
        if (!bot?.id) return null;

        const parsed = parseFeedback(bot.body || '');
        if (parsed.multiTicked) return 'multi';
        if (parsed.unknownLabel) return 'unknown';
        if (!parsed.optionKey) return null;

        const option = lookupOption(parsed.optionKey);
        if (!option) return 'unknown';

        return {
            noteId: bot.id,
            prUrl,
            repoId: repoId || null,
            findingId: parsed.findingId,
            optionKey: parsed.optionKey,
            weight: option.weight,
            file: discussion.file || null,
            line: discussion.line ?? null,
            rule: this._extractRule(bot.body),
            reasoning: this._formatReasoning(discussion.replies || [], botAuthor),
            collectedAt: Date.now(),
        };
    }

    /**
     * Recover the rule id from a posted comment body.
     * `buildCommentBody` renders it as `` (`rule-id`) `` in the headline, so this
     * is a reliable round-trip and lets AdaptiveLearningService key on the rule
     * rather than the finding text.
     */
    _extractRule(body) {
        const m = String(body ?? '').match(/^[^\n]*?\(`([^`]+)`\)/m);
        return m ? m[1] : null;
    }

    /** Concatenate the human replies — the "why" behind the tick. */
    _formatReasoning(replies, botAuthor) {
        const human = replies
            .filter(r => r && !r.system)
            .filter(r => !botAuthor || r.author !== botAuthor)
            .filter(r => (r.body || '').trim())
            .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

        if (!human.length) return null;
        return human.map(r => `**@${r.author || 'unknown'}**: ${r.body.trim()}`).join('\n\n---\n\n');
    }

    // ── persistence ────────────────────────────────────────────────────────

    async _read() {
        if (!this.storage) return [];
        try {
            const got = await this.storage.get(STORAGE_KEY);
            const list = got?.[STORAGE_KEY];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    /**
     * Upsert rows by noteId — a tick can be changed after the fact, and the
     * latest state of the checkbox is the truth, not the first one we saw.
     */
    async _persist(rows) {
        if (!this.storage) return;
        try {
            const existing = await this._read();
            const byNote = new Map(existing.map(r => [String(r.noteId), r]));
            for (const r of rows) byNote.set(String(r.noteId), r);

            const cutoff = Date.now() - this.ttlMs;
            const merged = [...byNote.values()]
                .filter(r => (r.collectedAt || 0) >= cutoff)
                .sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0))
                .slice(0, this.maxEntries);

            await this.storage.set({ [STORAGE_KEY]: merged });
        } catch (e) {
            console.warn('[Feedback] Persist failed:', e?.message);
        }
    }

    /**
     * Feed rejections into AdaptiveLearningService so a repeatedly-refuted rule
     * loses confidence and stops reaching the inline-comment threshold.
     *
     * Only negative-weight options count. "Valid — won't fix" is a correct
     * finding the team chose not to act on; training it down would teach the
     * reviewer to stop reporting true positives.
     */
    async _applyToAdaptiveLearning(rows, repoId) {
        if (!this.adaptiveLearning?.recordAction) return;
        for (const r of rows) {
            if (r.weight >= 0) continue;
            try {
                await this.adaptiveLearning.recordAction({
                    action: 'dismiss',
                    repoId: repoId || r.repoId,
                    ruleId: r.rule,
                    filePath: r.file,
                    reason: r.optionKey,
                });
            } catch (e) {
                console.warn('[Feedback] Adaptive learning update failed:', e?.message);
            }
        }
    }

    // ── read API for the miner / UI ────────────────────────────────────────

    /** All stored feedback, newest first. */
    async getLedger() {
        return this._read();
    }

    /**
     * Accepted/rejected tallies, optionally scoped to one repo. Drives the
     * "is this tool actually right?" number the eval harness has had to
     * approximate by hand-adjudication until now.
     */
    async getStats(repoId = null) {
        const rows = (await this._read()).filter(r => !repoId || r.repoId === repoId);
        const stats = { total: rows.length, accepted: 0, rejected: 0, neutral: 0, byRule: {} };

        for (const r of rows) {
            if (r.weight > 0) stats.accepted++;
            else if (r.weight < 0) stats.rejected++;
            else stats.neutral++;

            if (r.rule) {
                const e = stats.byRule[r.rule] || { accepted: 0, rejected: 0 };
                if (r.weight > 0) e.accepted++;
                else if (r.weight < 0) e.rejected++;
                stats.byRule[r.rule] = e;
            }
        }

        // The honest precision number, from real verdicts rather than proximity
        // matching. Undefined until someone has actually ticked a box.
        const adjudicated = stats.accepted + stats.rejected;
        stats.precision = adjudicated ? stats.accepted / adjudicated : null;

        return stats;
    }
}

export default FeedbackCollectorService;

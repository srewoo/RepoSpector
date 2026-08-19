/**
 * ConventionMiner — learn a team's review conventions from its own history.
 *
 * Measured motivation: on a 50-MR benchmark of real MindTickle merge requests,
 * RepoSpector matched 0 of 66 issues human reviewers raised. Reading those 66,
 * the largest single class was not defects at all — it was CONVENTION:
 *
 *   "Follow `tenant_id` as the naming convention. Correct at other places too."
 *   "Better use http status library for http status."
 *   "For naming the route, it's better to follow REST norms."
 *   "Can you please use bgcolor token here?"
 *   "Why are we not using ErrorPage from DL?"
 *   "Use mindtickle's default date formatter."
 *
 * No general-purpose reviewer can produce these. They are not in the diff, not in
 * any public best-practice list, and not in the generic `src/standards/*.md`. They
 * live in one place: the team's own past review comments. This is the one axis
 * where a BYOK tool can beat a hosted competitor that has the same models but not
 * this history.
 *
 * The miner distils recurring reviewer requests into a small set of repo-specific
 * rules, which `standardsLoader` then injects into the review prompt.
 *
 * Design constraints:
 * - Bounded cost: one LLM call per repo, cached with a TTL. Not per review.
 * - Bots excluded. An AI reviewer's own comments are not team convention, and
 *   training on them would compound its mistakes.
 * - Author replies excluded ("fixed in abc123") — those are resolutions, not rules.
 * - A rule must be recurring. A one-off preference is noise; requiring repetition
 *   is what separates a convention from an opinion.
 */

import { CONVENTION_MINING_SYSTEM_PROMPT, buildConventionMiningPrompt } from '../utils/conventionPrompts.js';

const STORAGE_KEY = 'repospectorMinedConventions';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // conventions drift slowly

/** AI reviewers and service accounts — never a source of team convention. */
const BOT_AUTHOR = /^(baymax|bito|coderabbit|sonar|snyk|dependabot|renovate|gitlab-bot|github-actions)/i;
const BOT_GROUP = /^group_\d+_bot_/i;

/** Author responses, not requests. */
const REPLY = /^\s*(valid\b|invalid\b|confirmed\b|agreed\b|resolved\b|fixed in\b|not applying\b|done\b|good catch\b|follow-?up:)/i;
const RESOLUTION = /\b(fixed in [0-9a-f]{6,}|added in [0-9a-f]{6,}|resolving\b|reverted\b)/i;

/** Content-free acknowledgements. */
const CHATTER = /^\s*(lgtm|looks good|nice|thanks|ty|\+1|👍|ok|okay)\b/i;

/**
 * Mines in progress, keyed by repoId.
 *
 * Module-level rather than an instance field on purpose: `prReviewHandlers`
 * constructs a fresh miner for every review, so an instance field could never
 * see the prewarm the indexing handler started moments earlier — which is the
 * entire point of warming.
 */
const inFlightMines = new Map();

export function isBotAuthor(author) {
    const a = String(author || '');
    return BOT_AUTHOR.test(a) || BOT_GROUP.test(a);
}

/**
 * Keep only notes that are a reviewer ASKING for something.
 * @param {Array<{author:string, body:string}>} notes
 */
export function reviewerRequests(notes = []) {
    return notes.filter(n => {
        const body = String(n?.body || '').trim();
        if (!body || body.length < 20) return false;
        if (isBotAuthor(n.author)) return false;
        if (REPLY.test(body) || RESOLUTION.test(body)) return false;
        if (CHATTER.test(body)) return false;
        return true;
    });
}

export class ConventionMiner {
    /**
     * @param {object} deps
     * @param {object} deps.llmService
     * @param {object} [deps.storage] - chrome.storage.local-compatible
     * @param {number} [deps.ttlMs]
     */
    constructor({ llmService, storage, ttlMs = DEFAULT_TTL_MS } = {}) {
        this.llmService = llmService;
        this.storage = storage || (typeof chrome !== 'undefined' ? chrome?.storage?.local : null);
        this.ttlMs = ttlMs;
    }

    async _readAll() {
        if (!this.storage) return {};
        try {
            const res = await this.storage.get(STORAGE_KEY);
            return res?.[STORAGE_KEY] || {};
        } catch { return {}; }
    }

    async _writeAll(all) {
        if (!this.storage) return;
        try { await this.storage.set({ [STORAGE_KEY]: all }); }
        catch (e) { console.warn('ConventionMiner: persist failed:', e?.message); }
    }

    /** Cached conventions for a repo, or null when absent/stale. */
    async getCached(repoId) {
        const all = await this._readAll();
        const entry = all[repoId];
        if (!entry) return null;
        if (this.ttlMs && Date.now() - (entry.minedAt || 0) > this.ttlMs) return null;
        return entry;
    }

    /**
     * Distil conventions from a repo's historical review notes.
     *
     * @param {string} repoId
     * @param {Array<{author:string, body:string, file?:string}>} notes
     * @param {object} opts - { settings, minOccurrences, maxRules, force }
     * @returns {Promise<{repoId:string, rules:Array, stats:object, minedAt:number}>}
     */
    async mine(repoId, notes, opts = {}) {
        const { settings = {}, maxRules = 12, force = false } = opts;

        if (!force) {
            const cached = await this.getCached(repoId);
            if (cached) return cached;
        }

        const requests = reviewerRequests(notes);
        const stats = {
            notesTotal: notes?.length || 0,
            reviewerRequests: requests.length,
            botsExcluded: (notes || []).filter(n => isBotAuthor(n.author)).length,
        };

        // Too little history to generalise from. Returning an empty rule set is
        // correct here — inventing conventions from three comments would put
        // confident nonsense into every future review prompt.
        if (requests.length < 8) {
            const result = { repoId, rules: [], stats: { ...stats, reason: 'insufficient history' }, minedAt: Date.now() };
            return result;
        }

        if (!this.llmService) {
            return { repoId, rules: [], stats: { ...stats, reason: 'no llm service' }, minedAt: Date.now() };
        }

        const prompt = buildConventionMiningPrompt(repoId, requests, { maxRules });
        let rules = [];
        try {
            const resp = await this.llmService.streamChat(
                [
                    { role: 'system', content: CONVENTION_MINING_SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false,
                    context: 'convention mining',
                }
            );
            rules = this._parseRules(resp?.content || resp).slice(0, maxRules);
        } catch (e) {
            console.warn(`ConventionMiner: mining failed for ${repoId}:`, e?.message);
            return { repoId, rules: [], stats: { ...stats, reason: 'llm error' }, minedAt: Date.now() };
        }

        const result = { repoId, rules, stats: { ...stats, rulesFound: rules.length }, minedAt: Date.now() };

        const all = await this._readAll();
        all[repoId] = result;
        await this._writeAll(all);

        console.log(`📐 Mined ${rules.length} convention(s) for ${repoId} from ${requests.length} reviewer comment(s)`);
        return result;
    }

    /**
     * Ensure conventions for `repoId` are mined, or being mined.
     *
     * Idempotent and safe to call from several places: a prewarm triggered by
     * indexing and a review starting a second later collapse to one LLM call.
     *
     * Never throws. A failed prewarm must not break the thing that triggered
     * it — indexing and review both proceed fine without conventions.
     *
     * @param {string} repoId
     * @param {() => Promise<Array<{author:string, body:string, file?:string}>>} notesFetcher
     * @param {object} [opts] - forwarded to `mine`
     * @returns {Promise<object|null>} the mined conventions, or null on failure
     */
    async prewarm(repoId, notesFetcher, opts = {}) {
        if (!repoId) return null;

        // Registration below is synchronous (no `await` precedes it) so that a
        // second, concurrent call — even one made before this call's first
        // microtask tick — sees the in-flight entry and dedupes against it.
        const existing = inFlightMines.get(repoId);
        if (existing) return existing;

        const task = (async () => {
            const cached = await this.getCached(repoId).catch(() => null);
            if (cached) return cached;

            const notes = await notesFetcher();
            return this.mine(repoId, notes || [], opts);
        })()
            .catch((e) => {
                console.warn(`ConventionMiner: prewarm for ${repoId} failed:`, e?.message);
                return null;
            })
            .finally(() => {
                // Cleared on both paths so a transient provider failure does not
                // wedge the repo into "permanently mining".
                inFlightMines.delete(repoId);
            });

        inFlightMines.set(repoId, task);
        return task;
    }

    /** The in-flight mine for a repo, or null. */
    static inFlight(repoId) {
        return inFlightMines.get(repoId) ?? null;
    }

    /**
     * True when `mined` is a genuine answer (cached success, including a
     * legitimately cached zero-rule result) rather than one of `mine()`'s
     * three non-persisting sentinel results ('insufficient history',
     * 'no llm service', 'llm error').
     *
     * `mine()`'s persisted success path stamps `stats.rulesFound`; the
     * non-persisting branches stamp `stats.reason` instead and never write to
     * storage. Callers should use this instead of `!!mined` or
     * `mined?.rules?.length` — the latter conflates "cached, genuinely no
     * conventions" (a real, reusable answer) with "no usable mine ran yet"
     * (which should trigger a fresh mine attempt).
     *
     * @param {{stats?:{reason?:string, rulesFound?:number}}|null|undefined} mined
     * @returns {boolean}
     */
    static isUsableResult(mined) {
        if (!mined) return false;
        return typeof mined.stats?.rulesFound === 'number';
    }

    /** Clear the registry. Test seam. */
    static resetInFlight() {
        inFlightMines.clear();
    }

    /**
     * Wait for an in-flight mine, but not past `deadlineMs`.
     *
     * A review must never be blocked indefinitely on convention mining. Losing
     * the race costs nothing beyond the wait: the caller falls back to the
     * generic standards, which is exactly the pre-warm-up behaviour.
     *
     * @param {string} repoId
     * @param {number} deadlineMs
     * @returns {Promise<object|null>}
     */
    static async awaitWarm(repoId, deadlineMs) {
        const pending = inFlightMines.get(repoId);
        if (!pending) return null;

        let timer;
        try {
            return await Promise.race([
                pending,
                new Promise((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    _parseRules(text) {
        if (!text || typeof text !== 'string') return [];
        let s = text.trim();
        if (s.startsWith('```json')) s = s.slice(7);
        else if (s.startsWith('```')) s = s.slice(3);
        if (s.endsWith('```')) s = s.slice(0, -3);
        s = s.trim();

        const tryParse = (str) => {
            try {
                const o = JSON.parse(str);
                if (Array.isArray(o?.rules)) return o.rules;
                if (Array.isArray(o)) return o;
            } catch { /* fall through */ }
            return null;
        };

        const parsed = tryParse(s) || tryParse((s.match(/\{[\s\S]*\}/) || [])[0] || '') || [];
        return parsed
            .filter(r => r && typeof r.rule === 'string' && r.rule.trim())
            .map(r => ({
                rule: String(r.rule).trim(),
                rationale: String(r.rationale || '').trim(),
                occurrences: Number(r.occurrences) || 1,
                example: String(r.example || '').trim(),
                category: String(r.category || 'convention').trim(),
            }));
    }

    /**
     * Render mined rules as a prompt block. Empty string when nothing was mined,
     * so callers can concatenate unconditionally.
     */
    static renderBlock(mined) {
        const rules = mined?.rules || [];
        if (!rules.length) return '';
        const lines = [
            '## Team conventions for this repository',
            '',
            'These are derived from what reviewers on THIS repo have actually asked for in',
            'past merge requests. Treat a violation as a real finding — it is what a human',
            'reviewer here would raise — but only when the diff clearly violates it.',
            '',
        ];
        for (const r of rules) {
            lines.push(`- **${r.rule}**${r.rationale ? ` — ${r.rationale}` : ''}${r.occurrences > 1 ? ` _(raised ${r.occurrences}×)_` : ''}`);
        }
        return lines.join('\n');
    }
}

export default ConventionMiner;

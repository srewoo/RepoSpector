import { SCORING_SYSTEM_PROMPT, buildScoringPrompt } from '../utils/scoringPrompts.js';
import { PRIORITY } from '../utils/callBudget.js';
import { settingsForStage } from '../utils/modelTiers.js';

/**
 * SuggestionScorer — rank surviving findings by how much they are worth saying.
 *
 * The posting policy used to order findings by severity alone, then truncate at
 * the inline cap. Severity is assigned by the model while writing each finding,
 * one at a time, with nothing to compare against and every incentive to inflate
 * — so "sort by severity, keep the first 15" is close to arbitrary among a set
 * of self-declared `high`s.
 *
 * This adds one pass over the whole surviving set that scores each finding 1-10
 * for reviewer value (see utils/scoringPrompts.js for the rubric). The score is
 * used to ORDER what gets posted, and optionally to gate it.
 *
 * Fail-open throughout: a finding the scorer does not return keeps its position
 * via a neutral score. A scoring outage must degrade ordering, never silently
 * delete findings that survived verification.
 */
export class SuggestionScorer {
    constructor({ llmService } = {}) {
        this.llmService = llmService;
    }

    /**
     * @param {Array<Object>} findings
     * @param {Object} opts
     * @param {Object} opts.prData
     * @param {Object} opts.settings - { provider, model, apiKey }
     * @param {number} [opts.batchSize=15]
     * @param {number} [opts.neutralScore=5] - assigned when the model returns none
     * @param {Function} [opts.onProgress]
     * @returns {Promise<{findings: Array, stats: Object, usage: {input:number,output:number}}>}
     */
    async score(findings = [], opts = {}) {
        const {
            prData = {},
            settings = {},
            batchSize = 15,
            neutralScore = 5,
            onProgress = null,
        } = opts;

        const usage = { input: 0, output: 0 };
        if (findings.length === 0 || !this.llmService) {
            return { findings, stats: this._emptyStats(findings.length), usage };
        }

        const tagged = findings.map((f, i) => ({ ...f, sid: `S${i}` }));
        const batches = this._chunk(tagged, batchSize);

        onProgress?.({ phase: 'scoring', message: `Scoring ${tagged.length} findings...`, total: tagged.length });

        const scoreBySid = new Map();
        const results = await Promise.all(batches.map(async (batch) => {
            try {
                const resp = await this.llmService.streamChat(
                    [
                        { role: 'system', content: SCORING_SYSTEM_PROMPT },
                        { role: 'user', content: buildScoringPrompt(batch, { prTitle: prData.title }) },
                    ],
                    { ...settingsForStage({ stage: 'scoring', provider: settings.provider, model: settings.model, apiKey: settings.apiKey, lightModel: settings.lightModel }), stream: false, budgetStage: 'scoring', budgetPriority: PRIORITY.OPTIONAL },
                );
                usage.input += resp?.usage?.input || 0;
                usage.output += resp?.usage?.output || 0;
                return this._parseScores(resp?.content || resp);
            } catch (e) {
                console.warn('Scoring batch failed (findings keep a neutral score):', e?.message);
                return [];
            }
        }));

        for (const list of results) {
            for (const entry of list) {
                const score = this._normScore(entry?.score);
                if (entry?.sid && score != null) {
                    scoreBySid.set(entry.sid, { score, reason: entry.reason ?? null });
                }
            }
        }

        let scored = 0;
        const out = tagged.map((f) => {
            const hit = scoreBySid.get(f.sid);
            const { sid: _sid, ...rest } = f;
            if (!hit) return { ...rest, score: neutralScore, scoreSource: 'default' };
            scored++;
            return { ...rest, score: hit.score, scoreReason: hit.reason, scoreSource: 'model' };
        });

        // Highest value first. Downstream caps (inline limit, summary section
        // limits) truncate from the end, so ordering here decides what a
        // reviewer actually sees when a PR produces more than fits.
        out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        const scores = out.map(f => f.score);
        const stats = {
            input: findings.length,
            scored,
            unscored: findings.length - scored,
            min: scores.length ? Math.min(...scores) : null,
            max: scores.length ? Math.max(...scores) : null,
            mean: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null,
        };

        onProgress?.({ phase: 'scoring', message: `Scored ${scored}/${findings.length}.`, ...stats });
        return { findings: out, stats, usage };
    }

    /** Clamp to the 1-10 integer scale; reject anything unparseable. */
    _normScore(raw) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;
        return Math.min(10, Math.max(1, Math.round(n)));
    }

    _parseScores(text) {
        if (!text || typeof text !== 'string') return [];
        let cleaned = text.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();

        const tryParse = (s) => {
            try {
                const o = JSON.parse(s);
                if (Array.isArray(o?.scores)) return o.scores;
                if (Array.isArray(o)) return o;
            } catch { /* ignore */ }
            return null;
        };
        return tryParse(cleaned) || tryParse((cleaned.match(/\{[\s\S]*\}/) || [])[0] || '') || [];
    }

    _chunk(arr, n) {
        const out = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
    }

    _emptyStats(input) {
        return { input, scored: 0, unscored: input, min: null, max: null, mean: null };
    }
}

export default SuggestionScorer;

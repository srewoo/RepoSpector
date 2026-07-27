import { FINDER_LENSES, buildLensFinderPrompt } from '../utils/finderLensPrompts.js';
import { freshFindings } from '../utils/findingDedup.js';

/**
 * MultiFinderService — recall booster.
 *
 * Runs several independent specialist finders (distinct lenses) over the diff and
 * keeps only findings the baseline pass missed. Loops until a round surfaces nothing
 * new ("loop-until-dry"), bounded by maxRounds so cost stays predictable. The
 * downstream verification pass culls any false positives these extra finders add,
 * so this trades a bounded amount of precision for recall — then gets it back.
 *
 * BYOK: every finder call uses the user's own provider/model.
 */
export class MultiFinderService {
    constructor({ llmService } = {}) {
        this.llmService = llmService;
    }

    /**
     * @param {Array<Object>} baseline - findings already produced (flat)
     * @param {Object} opts
     * @param {Object} opts.prData
     * @param {Object} opts.settings - { provider, model, apiKey }
     * @param {string} [opts.graphContext] - combined code-graph context text
     * @param {Array} [opts.lenses=FINDER_LENSES]
     * @param {number} [opts.maxRounds=2]
     * @param {Function} [opts.onProgress]
     * @returns {Promise<{ findings: Array, stats: Object, usage: {input:number,output:number} }>}
     */
    async findAdditional(baseline = [], opts = {}) {
        const {
            prData = {},
            settings = {},
            graphContext = '',
            lenses = FINDER_LENSES,
            maxRounds = 2,
            onProgress = null,
            // 'default' (precision-biased) | 'recall' — see finderLensPrompts RULES.
            promptMode = 'default'
        } = opts;

        if (!this.llmService) {
            return { findings: [], stats: { rounds: 0, added: 0, byLens: {} }, usage: { input: 0, output: 0 } };
        }

        const diffText = this._buildDiffText(prData);
        if (!diffText.trim()) {
            return { findings: [], stats: { rounds: 0, added: 0, byLens: {} }, usage: { input: 0, output: 0 } };
        }

        const usage = { input: 0, output: 0 };
        const byLens = {};
        const seen = [...baseline];
        const added = [];
        let rounds = 0;

        // Test-quality lens only matters when test files are in the diff.
        const hasTestFiles = (prData.files || []).some(f => /(\.test\.|\.spec\.|_test\.|test_|\/tests?\/)/i.test(f.filename || ''));
        const activeLenses = lenses.filter(l => l.key !== 'test-quality' || hasTestFiles);

        for (let round = 0; round < maxRounds; round++) {
            rounds++;
            onProgress?.({ phase: 'finding', message: `Diversity finders — round ${round + 1}...`, round: round + 1 });

            const existingTitles = seen.map(f => f.title || f.message || '').filter(Boolean);

            const roundResults = await Promise.all(activeLenses.map(async (lens) => {
                const { system, user } = buildLensFinderPrompt(lens, {
                    prTitle: prData.title,
                    diffText,
                    existingTitles,
                    graphContext,
                    mode: promptMode
                });
                try {
                    const resp = await this.llmService.streamChat(
                        [{ role: 'system', content: system }, { role: 'user', content: user }],
                        { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
                    );
                    usage.input += resp?.usage?.input || 0;
                    usage.output += resp?.usage?.output || 0;
                    const findings = this._parseFindings(resp?.content || resp)
                        .map(f => ({ ...f, source: 'llm', lens: lens.key }));
                    return { lens: lens.key, findings };
                } catch (e) {
                    console.warn(`Finder lens ${lens.key} failed:`, e?.message);
                    return { lens: lens.key, findings: [] };
                }
            }));

            // Collect this round's candidates, keep only genuinely new ones.
            let roundFresh = 0;
            for (const { lens, findings } of roundResults) {
                const fresh = freshFindings(seen, findings);
                for (const f of fresh) {
                    seen.push(f);
                    added.push(f);
                    byLens[lens] = (byLens[lens] || 0) + 1;
                    roundFresh++;
                }
            }

            if (roundFresh === 0) break; // dry — stop early
        }

        onProgress?.({ phase: 'finding', message: `Diversity finders added ${added.length} new findings.`, added: added.length });

        return { findings: added, stats: { rounds, added: added.length, byLens }, usage };
    }

    _buildDiffText(prData) {
        const parts = [];
        let budget = 12000;
        for (const f of (prData.files || [])) {
            if (!f.patch) continue;
            const chunk = `### ${f.filename}\n${f.patch}`;
            if (chunk.length > budget) {
                parts.push(chunk.slice(0, budget));
                break;
            }
            parts.push(chunk);
            budget -= chunk.length;
            if (budget <= 0) break;
        }
        return parts.join('\n\n');
    }

    _parseFindings(text) {
        if (!text || typeof text !== 'string') return [];
        let cleaned = text.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();
        const tryParse = (s) => {
            try {
                const o = JSON.parse(s);
                if (Array.isArray(o?.findings)) return o.findings;
                if (Array.isArray(o)) return o;
            } catch { /* ignore */ }
            return null;
        };
        return tryParse(cleaned) || tryParse((cleaned.match(/\{[\s\S]*\}/) || [])[0] || '') || [];
    }
}

export default MultiFinderService;

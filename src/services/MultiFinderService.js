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

    /**
     * Render the diff for the finder prompts under a total character budget.
     *
     * Every file gets a FAIR SHARE of the budget rather than the budget being
     * consumed front-to-back. The old version walked the files in order and
     * `break`ed the moment one did not fit — so a single large first file
     * consumed the whole 12k allowance and **no other file in the MR was ever
     * shown to any lens**. Since the multi-finder pass is what moved measured
     * human-comment recall from 0% to ~31%, that silently capped recall on
     * exactly the large MRs where the eval recorded its misses (`store.js`,
     * `head_wal.go`, `scheduling_queue.go` — all big files).
     *
     * Two passes: give every file its share, then redistribute what the small
     * files did not use to the ones that were truncated. Truncation is announced
     * inline so a lens knows it is looking at a partial file and does not reason
     * about "the rest of the function" it cannot see.
     *
     * @param {object} prData
     * @param {number} [totalBudget=12000]
     * @returns {string}
     */
    _buildDiffText(prData, totalBudget = 12000) {
        const withPatch = (prData.files || []).filter(f => f.patch);
        if (withPatch.length === 0) return '';

        // Below this a per-file slice is too small to reason about — three lines of
        // a hunk with no surrounding context is worse than not showing the file,
        // because it invites a finding the lens cannot actually ground.
        const MIN_SHARE = 400;

        // On a very wide MR the budget cannot give every file a usable slice. Show
        // as many as CAN get one, biggest-change first, and say what was left out.
        //
        // Applying the floor to every file instead — `max(MIN_SHARE, total/n)` —
        // silently multiplied the prompt past the budget it was supposed to enforce:
        // 100 files × 400 chars is 40k against a 12k budget. That is how a "budget"
        // fix ends up producing bigger prompts than the bug it replaced, and on a
        // slow reasoning model a bigger prompt is what pushes a call into the
        // request timeout and drops the whole review unit.
        const maxFiles = Math.max(1, Math.floor(totalBudget / MIN_SHARE));
        const sorted = [...withPatch].sort(
            (a, b) => String(b.patch).length - String(a.patch).length,
        );
        const omitted = Math.max(0, sorted.length - maxFiles);
        const rendered = sorted.slice(0, maxFiles).map(f => ({
            filename: f.filename,
            body: String(f.patch),
        }));

        const share = Math.max(MIN_SHARE, Math.floor(totalBudget / rendered.length));

        // Pass 1: what does each file actually need, capped at its share?
        let spent = 0;
        for (const r of rendered) {
            r.take = Math.min(r.body.length, share);
            spent += r.take;
        }

        // Pass 2: hand leftover budget to the files that were cut, round-robin, so
        // one huge file cannot reclaim everything the others freed up.
        let spare = totalBudget - spent;
        let starved = rendered.filter(r => r.take < r.body.length);
        while (spare > 0 && starved.length) {
            const slice = Math.max(1, Math.floor(spare / starved.length));
            let usedThisRound = 0;
            for (const r of starved) {
                if (spare - usedThisRound <= 0) break;
                const extra = Math.min(slice, r.body.length - r.take, spare - usedThisRound);
                r.take += extra;
                usedThisRound += extra;
            }
            if (usedThisRound === 0) break;  // nothing more can be placed
            spare -= usedThisRound;
            starved = starved.filter(r => r.take < r.body.length);
        }

        const sections = rendered.map((r) => {
            const truncated = r.take < r.body.length;
            const body = truncated ? r.body.slice(0, r.take) : r.body;
            const note = truncated
                ? `\n… (diff for this file truncated at ${r.take} of ${r.body.length} chars)`
                : '';
            return `### ${r.filename}\n${body}${note}`;
        });

        // Never let omission be silent: a lens told "here is the diff" will reason as
        // though it saw all of it.
        if (omitted > 0) {
            sections.push(
                `### (${omitted} further changed file(s) omitted — diff budget exhausted)`,
            );
        }

        return sections.join('\n\n');
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

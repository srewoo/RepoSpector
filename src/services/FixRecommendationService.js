import { FIX_RECOMMENDATION_SYSTEM_PROMPT, buildFixRecommendationPrompt } from '../utils/fixRecommendationPrompts.js';
import { PRIORITY } from '../utils/callBudget.js';
import { settingsForStage } from '../utils/modelTiers.js';

/**
 * FixRecommendationService — generates a concrete suggested patch per finding.
 *
 * Recommendation only: attaches a `suggestedFix` object to each finding. Nothing is
 * applied, committed, or pushed. Batched per file to keep BYOK token cost low.
 */
export class FixRecommendationService {
    constructor({ llmService } = {}) {
        this.llmService = llmService;
    }

    /**
     * @param {Array<Object>} findings - flat, verified findings
     * @param {Object} opts - { prData, settings, batchSize=6, maxFindings=40, onProgress }
     * @returns {Promise<{ findings: Array, stats: Object, usage: {input:number,output:number} }>}
     */
    async recommend(findings = [], opts = {}) {
        const { prData = {}, settings = {}, batchSize = 6, maxFindings = 40, onProgress = null } = opts;

        if (!this.llmService || findings.length === 0) {
            return { findings, stats: { requested: 0, produced: 0 }, usage: { input: 0, output: 0 } };
        }

        // Prioritise: only auto-write fixes for the most actionable findings (cap cost).
        const ranked = [...findings].sort((a, b) => this._sevRank(b.severity) - this._sevRank(a.severity));
        const targets = ranked.slice(0, maxFindings);

        // Tag + group by file
        const patchByFile = {};
        const contentByFile = {};
        for (const f of (prData.files || [])) {
            if (f.filename && f.patch) patchByFile[f.filename] = f.patch;
            if (f.filename && f.fullContent) contentByFile[f.filename] = f.fullContent;
        }

        const withFid = targets.map((f, i) => ({ ...f, fid: `FX${i}` }));
        const byFile = {};
        for (const f of withFid) {
            const key = f.file || '__unknown__';
            (byFile[key] = byFile[key] || []).push(f);
        }

        const usage = { input: 0, output: 0 };
        const fixByFid = new Map();

        onProgress?.({ phase: 'fixing', message: `Drafting fixes for ${withFid.length} findings...`, total: withFid.length });

        const fileEntries = Object.entries(byFile);
        await Promise.all(fileEntries.map(async ([file, fileFindings]) => {
            const batches = this._chunk(fileFindings, batchSize);
            for (const batch of batches) {
                const prompt = buildFixRecommendationPrompt(
                    file,
                    patchByFile[file] || '',
                    batch,
                    contentByFile[file] || ''
                );
                try {
                    const resp = await this.llmService.streamChat(
                        [
                            { role: 'system', content: FIX_RECOMMENDATION_SYSTEM_PROMPT },
                            { role: 'user', content: prompt }
                        ],
                        { ...settingsForStage({ stage: 'fixes', provider: settings.provider, model: settings.model, apiKey: settings.apiKey, lightModel: settings.lightModel }), stream: false, budgetStage: 'fixes', budgetPriority: PRIORITY.OPTIONAL }
                    );
                    usage.input += resp?.usage?.input || 0;
                    usage.output += resp?.usage?.output || 0;
                    for (const fix of this._parseFixes(resp?.content || resp)) {
                        if (fix?.fid) fixByFid.set(fix.fid, fix);
                    }
                } catch (e) {
                    console.warn(`Fix recommendation failed for ${file}:`, e?.message);
                }
            }
        }));

        // Attach suggestedFix back onto the original findings (by identity via fid map)
        const fidToFinding = new Map(withFid.map(f => [f.fid, f]));
        let produced = 0;
        for (const [fid, fix] of fixByFid) {
            const target = fidToFinding.get(fid);
            if (!target) continue;
            if (fix.replacement == null && fix.original == null) continue;
            target.suggestedFix = {
                original: fix.original ?? null,
                replacement: fix.replacement ?? null,
                explanation: fix.explanation || '',
                applicability: ['safe', 'review-needed'].includes(fix.applicability) ? fix.applicability : 'review-needed',
                confidence: Number(fix.confidence) || 0,
                recommendationOnly: true
            };
            produced++;
        }

        // withFid items are spread copies of the originals; map each produced fix
        // back onto the returned list by a stable content key, preserving order.
        const fixLookup = new Map();
        for (const w of withFid) {
            if (w.suggestedFix) fixLookup.set(this._key(w), w.suggestedFix);
        }
        const finalFindings = findings.map(f => {
            const fx = fixLookup.get(this._key(f));
            return fx ? { ...f, suggestedFix: fx } : f;
        });

        onProgress?.({ phase: 'fixing', message: `Drafted ${produced} fix recommendations.`, produced });

        return { findings: finalFindings, stats: { requested: withFid.length, produced }, usage };
    }

    _key(f) {
        return `${f.file || ''}:${f.line || ''}:${(f.title || f.message || '').slice(0, 40)}`;
    }

    _sevRank(s) {
        return { critical: 4, high: 3, medium: 2, low: 1 }[String(s || '').toLowerCase()] || 0;
    }

    _parseFixes(text) {
        if (!text || typeof text !== 'string') return [];
        let cleaned = text.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();
        const tryParse = (s) => {
            try {
                const o = JSON.parse(s);
                if (Array.isArray(o?.fixes)) return o.fixes;
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
}

export default FixRecommendationService;

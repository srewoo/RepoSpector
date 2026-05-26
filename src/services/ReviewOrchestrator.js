/**
 * ReviewOrchestrator — Bastion-style two-phase MR review pipeline.
 *
 *   evaluateSkipRules   →  short-circuit verdicts (DOCS_ONLY, oversized, draft, ...)
 *   MRChunker.chunkMR   →  split + build shared mr_brief
 *   Deep phase          →  per-chunk MultiPassReviewEngine call, brief inlined
 *   Standards phase     →  caller-supplied static findings (ESLint/Semgrep/...)
 *   FindingsNormalizer  →  hard-filter to assigned hunks
 *   buildVerdictReport  →  canonical { verdict, findings, summary, counts }
 *
 * Additive layer — does NOT modify MultiPassReviewEngine. Existing callers
 * that bypass the orchestrator keep working unchanged.
 */

import { evaluateSkipRules } from './SkipRuleEngine.js';
import { chunkMR } from './MRChunker.js';
import {
    buildAssignedHunks,
    filterToAssignedHunks,
} from './FindingsNormalizer.js';
import {
    buildVerdictReport,
    toCanonicalFinding,
    PHASE,
    VERDICT,
    CATEGORY,
} from './reviewSchema.js';

export class ReviewOrchestrator {
    /**
     * @param {object} deps
     * @param {object} deps.multiPassEngine   - existing MultiPassReviewEngine instance
     * @param {object} [deps.findingCache]    - optional FindingCache for stats
     * @param {object} [deps.telemetry]       - optional TelemetryService
     */
    constructor({ multiPassEngine, findingCache, telemetry } = {}) {
        if (!multiPassEngine) {
            throw new Error('ReviewOrchestrator requires multiPassEngine');
        }
        this.multiPass = multiPassEngine;
        this.findingCache = findingCache;
        this.telemetry = telemetry;
    }

    /**
     * @param {object} prData    - normalized PR/MR data from PullRequestService
     * @param {object} context   - { ragContext, repoDocumentation, staticFindings, ... }
     * @param {object} settings  - { provider, model, apiKey }
     * @param {object} options   - { focusAreas, maxConcurrent, maxFilesToReview, chunking }
     * @param {Function} onProgress - (event) => void
     * @returns {Promise<VerdictReport>}
     */
    async review(prData, context = {}, settings = {}, options = {}, onProgress = null) {
        const startedAt = Date.now();
        if (this.findingCache?.resetStats) this.findingCache.resetStats();

        // ── 1. Skip-rule gate ─────────────────────────────────────────────
        const gate = evaluateSkipRules(prData, options.skipRules);
        onProgress?.({ step: 'skip_rules', gate });

        if (gate.action === 'SKIP' || gate.action === 'DEFER') {
            return buildVerdictReport({
                findings: [],
                override: gate.action === 'DEFER' ? VERDICT.DEFER : VERDICT.SKIP,
                summary: {
                    deep: `Review ${gate.action.toLowerCase()}: ${gate.reason}`,
                    standards: '',
                },
                meta: {
                    durationMs: Date.now() - startedAt,
                    gate,
                    schemaPhases: [],
                },
            });
        }

        if (gate.action === 'AUTO_VERDICT') {
            return buildVerdictReport({
                findings: [],
                override: gate.verdict,
                summary: {
                    deep: `Auto-verdict (${gate.classification}): ${gate.reason}`,
                    standards: '',
                },
                meta: {
                    durationMs: Date.now() - startedAt,
                    gate,
                    schemaPhases: [],
                },
            });
        }

        // ── 2. Chunk + build shared brief ────────────────────────────────
        const { chunks, brief, summary: chunkSummary } = chunkMR(
            prData,
            options.chunking,
        );
        onProgress?.({ step: 'chunked', chunkSummary });

        // ── 3. Deep phase — fan out chunks through the existing engine ──
        const deepFindings = [];
        let deepNarrative = '';
        const failedChunks = [];

        for (const chunk of chunks) {
            onProgress?.({
                step: 'deep_review',
                chunkIndex: chunk.index,
                totalChunks: chunk.total,
            });

            const chunkPrData = { ...prData, files: chunk.files };
            const chunkContext = {
                ...context,
                mrBrief: brief,
                chunkInfo: {
                    index: chunk.index,
                    total: chunk.total,
                    loc: chunk.loc,
                    reason: chunk.reason,
                },
            };

            try {
                const result = await this.multiPass.execute(
                    chunkPrData,
                    chunkContext,
                    settings,
                    options,
                    (sub) => onProgress?.({
                        step: 'deep_review_sub',
                        chunkIndex: chunk.index,
                        ...sub,
                    }),
                );

                if (result.analysis) {
                    deepNarrative += result.analysis + '\n\n';
                }
                // Lift this chunk's findings and emit them via onProgress so
                // the UI can render incrementally. Without this the UI shows
                // a blank panel for the full LLM duration — for a 50-file MR
                // that's 60+ seconds of dead time.
                const chunkFindings = (result.perFileFindings ?? []).map((f) =>
                    toCanonicalFinding(f, {
                        phase: PHASE.DEEP,
                        source: 'llm',
                        category: CATEGORY.LOGIC,
                    }),
                ).filter(Boolean);

                deepFindings.push(...chunkFindings);

                onProgress?.({
                    step: 'chunk_findings',
                    chunkIndex: chunk.index,
                    totalChunks: chunk.total,
                    findings: chunkFindings,
                    chunkSummary: result.analysis ?? '',
                });

                if (result.failedFiles?.length) failedChunks.push({ chunk: chunk.index, failedFiles: result.failedFiles });
            } catch (err) {
                failedChunks.push({ chunk: chunk.index, error: err.message });
                onProgress?.({
                    step: 'deep_review_error',
                    chunkIndex: chunk.index,
                    error: err.message,
                });
            }
        }

        // ── 4. Standards phase — lift caller-supplied static findings ──
        const standardsFindings = (context.staticFindings ?? []).map((f) =>
            toCanonicalFinding(f, {
                phase: PHASE.STANDARDS,
                source: f.source ?? f.tool ?? 'static',
                category: f.category ?? CATEGORY.LINT,
            }),
        );

        // ── 5. Filter both phases to the MR's actual changed hunks ──────
        const allow = buildAssignedHunks(toParsedFiles(prData.files));
        const deepFiltered = filterToAssignedHunks(
            deepFindings.filter(Boolean),
            allow,
            options.normalization,
        );
        const stdFiltered = filterToAssignedHunks(
            standardsFindings.filter(Boolean),
            allow,
            options.normalization,
        );

        // ── 6. Dedupe across chunks ─────────────────────────────────────
        const merged = dedupeFindings([...deepFiltered.kept, ...stdFiltered.kept]);

        // ── 7. Build the canonical report ───────────────────────────────
        const report = buildVerdictReport({
            findings: merged,
            summary: {
                deep: deepNarrative.trim() || 'No deep-phase narrative produced.',
                standards: stdFiltered.kept.length
                    ? `${stdFiltered.kept.length} standards findings after normalization.`
                    : 'No standards findings.',
            },
            meta: {
                durationMs: Date.now() - startedAt,
                gate,
                chunkSummary,
                brief,
                normalization: {
                    deep: deepFiltered.stats,
                    standards: stdFiltered.stats,
                },
                cache: this.findingCache?.getStats?.() ?? null,
                failedChunks,
            },
        });

        // ── 8. Optional telemetry ──────────────────────────────────────
        if (this.telemetry?.record) {
            try {
                await this.telemetry.record({
                    kind: 'pr_review',
                    durationMs: report.meta.durationMs,
                    findingsTotal: deepFindings.length + standardsFindings.length,
                    findingsKept: merged.length,
                    model: settings.model,
                    ...(this.findingCache?.getStats?.() ?? {}),
                });
            } catch { /* never fail review on telemetry error */ }
        }

        return report;
    }
}

/**
 * Cross-chunk dedupe: collapse findings that share (file, line, normalized
 * suggestion prefix). Keeps the highest-severity copy.
 */
function dedupeFindings(findings) {
    const SEVERITY_RANK = { blocking: 3, suggestion: 2, nitpick: 1 };
    const byKey = new Map();
    for (const f of findings) {
        const key = [
            f.file ?? '',
            f.line ?? '',
            (f.suggestion ?? '').slice(0, 60).toLowerCase().replace(/\s+/g, ' '),
        ].join('|');
        const prev = byKey.get(key);
        if (!prev || (SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[prev.severity] ?? 0)) {
            byKey.set(key, f);
        }
    }
    return [...byKey.values()];
}

/**
 * Adapter — PullRequestService gives us patches per file. The normalizer
 * wants parsed hunks. We reconstruct a minimal hunk list from the unified
 * patch lines, which is enough for line-allow-list construction.
 */
function toParsedFiles(files) {
    const out = [];
    for (const f of files ?? []) {
        const newPath = f.filename ?? f.new_path ?? f.path;
        if (!newPath) continue;

        const patch = f.patch ?? f.diff ?? '';
        const hunks = parsePatchHunks(patch);
        out.push({ newPath, hunks });
    }
    return out;
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parsePatchHunks(patch) {
    if (!patch) return [];
    const hunks = [];
    let cur = null;
    let newLineCursor = 0;

    for (const line of patch.split('\n')) {
        const m = line.match(HUNK_HEADER_RE);
        if (m) {
            if (cur) hunks.push(cur);
            const newStart = parseInt(m[3], 10);
            const newLines = parseInt(m[4] || '1', 10);
            cur = { newStart, newLines, lines: [] };
            newLineCursor = newStart;
            continue;
        }
        if (!cur) continue;

        if (line.startsWith('+') && !line.startsWith('+++')) {
            cur.lines.push({ type: 'added', number: { new: newLineCursor, old: null } });
            newLineCursor++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            cur.lines.push({ type: 'deleted', number: { new: null, old: null } });
        } else if (line.startsWith(' ')) {
            cur.lines.push({ type: 'context', number: { new: newLineCursor, old: null } });
            newLineCursor++;
        }
    }
    if (cur) hunks.push(cur);
    return hunks;
}

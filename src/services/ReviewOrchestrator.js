/**
 * ReviewOrchestrator — two-phase MR review pipeline.
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
import { liftEngineFindings } from './engineContract.js';
import { normalizeFindingKeys } from './FindingsNormalizer.js';
import { parsePatchHunks } from '../utils/patchLines.js';

/** Wall-clock cap per chunk. */
export const DEFAULT_CHUNK_TIMEOUT_MS = 240_000;

/**
 * Reject after `ms` if `promise` has not settled.
 *
 * Note this does not CANCEL the underlying work — an in-flight fetch keeps
 * running to completion in the background. What it bounds is how long the
 * orchestrator waits, which is the property that matters: the review completes
 * with the chunks that did finish rather than hanging on the one that didn't.
 */
export function withTimeout(promise, ms, label) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s: ${label}`)),
            ms,
        );
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fold per-chunk narratives into one review summary.
 *
 * Done deterministically rather than with a cheap extra LLM call: a BYOK user
 * pays for every call, and the failure this fixes is structural
 * rather than stylistic: N chunk narratives concatenated produce N copies of
 * "## Summary", N verdict paragraphs, and a reader who cannot tell where one
 * chunk's opinion ends and the next begins.
 *
 * Hence one unified `## Code Review` section rather than per-chunk
 * `### Chunk N/total` headers.
 *
 * @param {string[]} narratives - per-chunk analysis text, in chunk order
 * @returns {string}
 */
export function consolidateNarratives(narratives) {
    const parts = (narratives || []).map(n => String(n ?? '').trim()).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];

    // Demote every heading by one level so the chunk narratives nest under a
    // single top-level section instead of competing with it.
    const demoted = parts.map(p => p.replace(/^(#{1,5})\s/gm, '$1# '));

    const seen = new Set();
    const deduped = [];
    for (const part of demoted) {
        // Chunks reviewing sibling files routinely emit byte-identical
        // boilerplate ("No critical issues found."). Say it once.
        const key = part.replace(/\s+/g, ' ').trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(part);
    }

    return [
        '## Code Review',
        '',
        `_Reviewed in ${parts.length} chunks; findings below are merged and deduplicated._`,
        '',
        deduped.join('\n\n'),
    ].join('\n');
}

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

        // ── 1b. Partial review budget ────────────────────────────────────
        // An oversized MR is reviewed, not skipped, but only across the files the
        // gate selected. Narrowing `prData` here (rather than inside the engine)
        // keeps chunking, the brief and the assigned-hunk allow-list all consistent
        // with what was actually read — an allow-list covering files nobody reviewed
        // would let a stale carried finding through the normalizer.
        let effectivePrData = prData;
        if (gate.partial?.reviewedFiles?.length) {
            const keep = new Set(gate.partial.reviewedFiles);
            const selected = (prData.files ?? []).filter(
                f => keep.has(f.filename ?? f.path ?? f.new_path),
            );
            if (selected.length) {
                effectivePrData = { ...prData, files: selected };
                console.warn(
                    `⚠️ Partial review (${gate.partial.reason}): reviewing ` +
                    `${selected.length} of ${gate.partial.totalFiles} files; ` +
                    `${gate.partial.skippedFileCount} not read`
                );
                onProgress?.({ step: 'partial_review', partial: gate.partial });
            }
        }

        // ── 2. Chunk + build shared brief ────────────────────────────────
        // Windowing is deliberately NOT threaded through here. `chunkMR`'s
        // packing pass groups files by loc via `locOf()`, which reads a
        // file's whole additions/deletions regardless of window boundaries
        // — so two windows of the same file can land in the same chunk with
        // the same filename, and the downstream `assigned.has(filename)`
        // dedup in FileGroupingStrategy silently drops one of them. Windowing
        // happens exactly once, later, inside MultiPassReviewEngine per
        // already-formed chunk — do not re-add it here.
        const { chunks, brief, summary: chunkSummary } = chunkMR(
            effectivePrData,
            options.chunking,
        );
        onProgress?.({ step: 'chunked', chunkSummary });

        // ── 3. Deep phase — fan out chunks through the existing engine ──
        const deepFindings = [];
        const chunkNarratives = [];
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
                // Per-chunk wall-clock cap. One pathological
                // chunk — a huge generated file, a model that stalls mid-stream —
                // must not hold the whole review hostage. The chunk is recorded as
                // failed and the remaining chunks still produce a review.
                const result = await withTimeout(
                    this.multiPass.execute(
                        chunkPrData,
                        chunkContext,
                        settings,
                        options,
                        (sub) => onProgress?.({
                            step: 'deep_review_sub',
                            chunkIndex: chunk.index,
                            ...sub,
                        }),
                    ),
                    options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS,
                    `chunk ${chunk.index}/${chunk.total}`,
                );

                if (result.analysis) {
                    chunkNarratives.push(result.analysis);
                }
                // Lift this chunk's findings and emit them via onProgress so
                // the UI can render incrementally. Without this the UI shows
                // a blank panel for the full LLM duration — for a 50-file MR
                // that's 60+ seconds of dead time.
                //
                // MultiPassReviewEngine returns `perFileFindings` as an array of
                // per-file objects, each with a nested `findings` array. Older /
                // stub engines return an already-flat findings array. liftEngineFindings
                // handles both so real per-file findings aren't collapsed into one
                // empty file-level finding.
                // Repair schema drift (typo'd keys, `"42"` line numbers, arrays
                // where prose was asked for) BEFORE canonicalisation, so a
                // mis-keyed severity doesn't silently default to "suggestion".
                const repaired = normalizeFindingKeys(liftEngineFindings(result.perFileFindings));
                if (repaired.stats.aliasedKeys || repaired.stats.coercedLines) {
                    console.warn(
                        `[Normalizer] chunk ${chunk.index}: repaired ${repaired.stats.aliasedKeys} key(s), ` +
                        `${repaired.stats.coercedLines} line value(s) — prompt drift, worth checking`
                    );
                }

                const chunkFindings = repaired.findings.map((f) =>
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
        // Built from the files that were actually reviewed, so a partial run cannot
        // admit a finding on a file it never read.
        const allow = buildAssignedHunks(toParsedFiles(effectivePrData.files));
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
        // A truncated review must SAY it was truncated, at the top of the narrative.
        // Silence here reads as "we looked at everything and found this much", which
        // is the one thing a partial review must never imply.
        const partialNote = gate.partial
            ? `> ⚠️ **Partial review.** This MR changes ${gate.partial.totalFiles} files `
              + `(${gate.partial.totalLoc} lines). ${gate.partial.reviewedFiles.length} `
              + `file(s) were reviewed, prioritised by change size and excluding generated `
              + `code; **${gate.partial.skippedFileCount} file(s) were not read.** `
              + `Absence of findings in those files is not evidence they are correct.\n`
            : '';

        const report = buildVerdictReport({
            findings: merged,
            summary: {
                deep: partialNote
                    + (consolidateNarratives(chunkNarratives) || 'No deep-phase narrative produced.'),
                standards: stdFiltered.kept.length
                    ? `${stdFiltered.kept.length} standards findings after normalization.`
                    : 'No standards findings.',
            },
            meta: {
                durationMs: Date.now() - startedAt,
                gate,
                partial: gate.partial ?? null,
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
 * wants parsed hunks.
 *
 * The parse itself MUST come from `patchLines`. This file used to carry its own
 * copy, and the copies had already drifted: the local one had no `\ No newline`
 * handling and a different notion of a context line. That is precisely the bug
 * `patchLines`' module note warns about — the assigned-hunk allow-list built
 * here and the posting allow-list built there disagreed, so a finding could
 * survive one filter and be dropped by the other.
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

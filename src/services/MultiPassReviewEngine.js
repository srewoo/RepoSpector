import { BatchProcessor } from '../utils/batchProcessor.js';
import { FileGroupingStrategy } from './FileGroupingStrategy.js';
import { scoreFileByRisk } from '../utils/prompts.js';
import { HUNK_WINDOWING } from '../utils/constants.js';
import { PRIORITY } from '../utils/callBudget.js';
import { isAuthError, markAuthError } from '../utils/authErrors.js';
import { fitFilesToBudget } from '../utils/diffBudget.js';
import { tokenManager } from '../utils/tokenManager.js';
import {
    PER_FILE_REVIEW_SYSTEM_PROMPT,
    AGGREGATION_SYSTEM_PROMPT,
    buildPerFileReviewPrompt,
    buildAggregationPrompt,
    buildPRContextSummary,
    getLanguageRules
} from '../utils/multiPassPrompts.js';
import { createCompleteness } from '../utils/reviewCompleteness.js';

/**
 * Multi-pass PR review engine.
 * Orchestrates: file grouping → parallel per-file LLM reviews → cross-file aggregation.
 */
export class MultiPassReviewEngine {
    constructor({ llmService, ragService } = {}) {
        this.llmService = llmService;
        this.ragService = ragService;
    }

    /**
     * Execute multi-pass review
     * @param {Object} prData - Normalized PR data from PullRequestService
     * @param {Object} context - { ragContext, repoDocumentation, staticFindings, isTestAutomationPR }
     * @param {Object} settings - { provider, model, apiKey }
     * @param {Object} options - { focusAreas, maxConcurrent, maxFilesToReview }
     * @param {Function} onProgress - (progressEvent) => void
     * @returns {Promise<MultiPassResult>}
     */
    async execute(prData, context = {}, settings = {}, options = {}, onProgress = null) {
        const startTime = Date.now();
        const { focusAreas = ['security', 'bugs', 'performance'] } = options;
        const maxConcurrent = options.maxConcurrent || 3;

        // Service-worker keepalive — every 25s, inside MV3's 30s idle window.
        //
        // This used to be `chrome.runtime.sendMessage({type:'KEEPALIVE'})`, which was
        // a NO-OP twice over: nothing in the extension listens for `KEEPALIVE`, and
        // Chrome does not deliver a service worker's own message back to itself — so
        // the send rejected every time and the `.catch(() => {})` hid it. The worker
        // could be torn down mid-review, which with `stream: false` is exactly the
        // long quiet window where nothing else resets the timer.
        //
        // Calling an extension API that actually crosses into the browser process
        // does reset it. `getPlatformInfo` is the cheapest such call and needs no
        // permission.
        const keepAlive = setInterval(() => {
            try {
                const info = chrome.runtime.getPlatformInfo?.();
                // Chrome ≥ 99 returns a promise; older signatures take a callback.
                if (info?.catch) info.catch(() => {});
            } catch (e) { /* never let the keepalive break a review */ }
        }, 25000);

        try {
            // ── Phase 1: Prepare ──
            onProgress?.({ phase: 'preparing', message: 'Preparing review data...' });

            const prContext = buildPRContextSummary(prData);
            const findingsByFile = this._groupFindingsByFile(context.staticFindings || []);
            const ragByFile = this._distributeRAGContext(context.ragContext, prData.files);

            // ── Phase 2: Group files ──
            onProgress?.({ phase: 'grouping', message: 'Grouping files for review...' });

            const groupingStrategy = new FileGroupingStrategy({
                hunkWindowing: settings?.hunkWindowing ?? HUNK_WINDOWING,
            });
            const maxFiles = options.maxFilesToReview || 50;

            // Order by RISK before truncating, not by whatever order the provider
            // returned the files in.
            //
            // `slice()` on the raw array was a silent correctness bug on any PR
            // above the cap. Provider order is effectively alphabetical by path,
            // so `tests/` sorts last and every test file is dropped FIRST —
            // measured on a 30-file MR with the cap at 20: all nine test files
            // and `pyproject.toml` were cut, and the review then missed a
            // test-quality defect a competing reviewer found, because the file
            // holding it was never sent to the model.
            //
            // `scoreFileByRisk` is the same ranking `buildReviewPrompt` has always
            // applied for the single-pass path (prompts.js), so this makes the two
            // paths agree rather than inventing a policy.
            const ranked = prData.files
                .map(f => ({ file: f, risk: scoreFileByRisk(f) }))
                .sort((a, b) => b.risk - a.risk)
                .map(x => x.file);
            const filesToReview = ranked.slice(0, maxFiles);
            const skipped = ranked.slice(maxFiles);
            const reviewUnits = groupingStrategy.group(filesToReview, { findingsByFile });

            console.log(`📋 Multi-pass: ${reviewUnits.length} review units from ${filesToReview.length} files`);

            // Say what was dropped. A silent truncation reads exactly like a
            // clean review of the whole PR, which is how "it found nothing in
            // that file" and "it never looked at that file" became
            // indistinguishable.
            if (skipped.length > 0) {
                console.warn(
                    `⚠️ Multi-pass: ${skipped.length} of ${prData.files.length} files were NOT reviewed `
                    + `(cap ${maxFiles}, lowest risk first): `
                    + skipped.slice(0, 10).map(f => f.filename).join(', ')
                    + (skipped.length > 10 ? `, +${skipped.length - 10} more` : '')
                );
            }
            this.lastSkippedFiles = skipped.map(f => f.filename);

            onProgress?.({
                phase: 'reviewing',
                message: `Reviewing ${reviewUnits.length} file groups...`,
                totalUnits: reviewUnits.length,
                completedUnits: 0,
                percentage: 0
            });

            // ── Phase 3: Per-file review ──
            const batchProcessor = new BatchProcessor({
                maxConcurrent,
                timeout: 120000, // 2 min per review
                retryAttempts: 1,
                retryDelay: 2000
            });

            // P0-1: hunks/files the diff budget refused to send are content this
            // review never saw. Named in the prompt already, but the VERDICT has
            // to know about them too — a file omitted for budget is not a file
            // reviewed and found clean.
            const budgetOmissions = [];
            // What the measured prompt reserve turned out to be, per unit. A
            // budget nobody measures is a guess with a number on it.
            const promptFits = [];

            const results = await batchProcessor.processBatches(
                [reviewUnits], // Single batch, concurrency handled by semaphore
                async (unit) => {
                    // ── Diff budget ──────────────────────────────────────────
                    //
                    // Reserve room for the RESPONSE before deciding how much diff
                    // to send. A prompt that fills the window comes back truncated,
                    // which surfaces as a JSON parse failure — a review that had all
                    // the context it needed and produced nothing. Files that do not
                    // fit are named rather than dropped silently, so the model cannot
                    // conclude that a caller was never updated. See utils/diffBudget.js.
                    const contextWindow = tokenManager.getModelLimit(settings.model);
                    // P1-5: the reserve for the non-diff sections was a flat 20%
                    // of the window, which is not a measurement of anything. On a
                    // unit with heavy RAG, graph and full-file context it
                    // under-reserved and the response came back truncated — a
                    // parse failure from a review that had all the context it
                    // needed. On a bare unit it over-reserved and dropped hunks
                    // that would have fitted. Fit once on the estimate, MEASURE
                    // the assembled prompt, and re-fit against the real overhead
                    // when the estimate was wrong.
                    const fitWith = (promptTokens) => fitFilesToBudget({
                        files: unit.files,
                        contextWindowTokens: contextWindow,
                        promptTokens,
                    });
                    let reservedPromptTokens = Math.round(contextWindow * 0.2);
                    let fitted = fitWith(reservedPromptTokens);

                    // Never review nothing. If even the first file does not fit, the
                    // unit is reviewed as-is: an over-long prompt that the provider
                    // may still handle beats skipping a changed file outright, and
                    // `HunkWindower` has already split anything genuinely huge.
                    const unitForPrompt = fitted.included.length
                        ? { ...unit, files: fitted.included }
                        : unit;
                    const omittedFiles = fitted.included.length ? fitted.omitted : [];

                    if (omittedFiles.length) {
                        for (const f of omittedFiles) {
                            const removalsOnly = f.omittedBecause === 'no added lines';
                            budgetOmissions.push({
                                kind: removalsOnly ? 'removals-only' : 'diff-budget',
                                detail: f.omittedBecause || 'omitted',
                                file: f.filename ?? f.path ?? null,
                                // Removals-only files are stripped by design today
                                // (P1-1 changes that). Record the fact without
                                // making every deletion downgrade the verdict; a
                                // file dropped for BUDGET is a genuine gap.
                                advisory: removalsOnly,
                            });
                        }
                        console.log(
                            `✂️  Diff budget: showing ${fitted.included.length}/${unit.files.length} `
                            + `file(s) of this unit (${fitted.stats.diffTokens} diff tokens, `
                            + `${fitted.stats.deletionOnlyHunksRemoved} deletion-only hunk(s) stripped)`
                        );
                    }

                    const buildPrompt = (forUnit, extraOmitted) => buildPerFileReviewPrompt(forUnit, {
                        prContext,
                        focusAreas,
                        ragChunks: this._getRAGChunksForUnit(ragByFile, unit),
                        staticFindings: this._getStaticFindingsForUnit(findingsByFile, unit),
                        // `getLanguageRules` returns an OBJECT ({deprecated,
                        // securityChecks, patterns, performanceChecks}) which the
                        // prompt builder indexes into. It was previously being
                        // `.join()`ed with the convention text, which stringified
                        // it to "[object Object]" — so every `rules.deprecated?.
                        // length` check saw undefined and the entire language-rules
                        // section rendered empty, taking the mined conventions with
                        // it. Pass the object through and keep conventions separate.
                        languageRules: getLanguageRules(unit.files[0]?.language),
                        // Team conventions mined from THIS repo's own review history.
                        // On the 50-MR benchmark the largest class of missed human
                        // comments was convention, not defect — no generic rule set
                        // contains "use the bgcolor token" or "follow tenant_id naming".
                        conventionBlock: context.conventionBlock || '',
                        standardsText: context.standardsText || '',
                        // The conventions this repo already wrote down for its own
                        // coding agents — read from the default branch, so this is
                        // guidance that has itself passed review.
                        repoInstructions: context.repoInstructions || '',
                        instructionScopes: context.instructionScopes || null,
                        graphContext: this._getGraphContextForUnit(context.graphContext, unit),
                        // Phase 2: the file itself and its test, plus what the
                        // change was supposed to do. Both are optional — a review
                        // still runs (patch-only, as before) when they're absent.
                        fileContext: context.fileContext || null,
                        intentBlock: context.intentBlock || '',
                        // How much retrieved repo context this prompt may carry.
                        contextBudget: context.contextBudget || null,
                        // Declaration ranges per file, so a large file's hunks are
                        // grown to the function or class that encloses them instead
                        // of the whole file being pasted in. See utils/dynamicContext.js.
                        declarationsByFile: context.declarationsByFile || null,
                        dynamicContext: context.dynamicContext || null,
                        omittedFiles: extraOmitted,
                        omittedHunks: fitted.stats.omittedHunks,
                    });

                    let prompt = buildPrompt(unitForPrompt, omittedFiles);

                    // The measured overhead: everything in the assembled prompt
                    // that is not this unit's diff text.
                    const diffTokens = fitted.stats.diffTokens || 0;
                    const measuredOverhead = Math.max(
                        0, tokenManager.estimateTokens(prompt) - diffTokens,
                    );
                    // Re-fit only when the estimate was materially wrong, so the
                    // common case still costs one build.
                    if (Math.abs(measuredOverhead - reservedPromptTokens) > contextWindow * 0.02) {
                        reservedPromptTokens = measuredOverhead;
                        fitted = fitWith(reservedPromptTokens);
                        const refitUnit = fitted.included.length
                            ? { ...unit, files: fitted.included }
                            : unit;
                        const refitOmitted = fitted.included.length ? fitted.omitted : [];
                        prompt = buildPrompt(refitUnit, refitOmitted);
                        promptFits.push({
                            unit: unit.primaryFile ?? null,
                            estimatedOverhead: Math.round(contextWindow * 0.2),
                            measuredOverhead,
                            refitted: true,
                        });
                    }

                    const response = await this.llmService.streamChat(
                        [
                            { role: 'system', content: PER_FILE_REVIEW_SYSTEM_PROMPT },
                            { role: 'user', content: prompt }
                        ],
                        {
                            provider: settings.provider,
                            model: settings.model,
                            apiKey: settings.apiKey,
                            budgetStage: 'per-file',
                            budgetPriority: PRIORITY.ESSENTIAL,
                            stream: false
                        }
                    );

                    // Carry the per-call token usage out alongside the parsed
                    // result so the engine can accumulate the totals. Field is
                    // named `parsed` (not `findings`) because the parsed object
                    // itself has a nested .findings array — avoid the collision.
                    return {
                        parsed: this._parsePerFileResponse(response.content || response, unit),
                        usage: response.usage || { input: 0, output: 0 },
                    };
                },
                (progress) => {
                    onProgress?.({
                        phase: 'reviewing',
                        message: `Reviewed ${progress.completed}/${reviewUnits.length} file groups...`,
                        totalUnits: reviewUnits.length,
                        completedUnits: progress.completed,
                        percentage: progress.percentage
                    });
                }
            );

            // Unpack {parsed, usage} from each successful unit. `parsed` is
            // the per-file result object (with its own nested findings array).
            // Accumulate input/output tokens across the per-file pass; the
            // aggregation call adds to this at the end.
            const perFileFindings = results.successful.map(r => r.data.parsed);

            // A unit whose LLM call succeeded but whose response never parsed
            // as JSON comes back from `_fallbackResponse` as `findings: []`
            // plus the raw text in `rawAnalysis` — which is bit-for-bit what a
            // genuinely clean file looks like downstream. Nobody reads
            // `rawAnalysis` or `parseError`, so without this counter a unit
            // with real findings that got truncated (or a model that replied
            // with prose instead of JSON) silently reads as "no problems
            // found" instead of "not read". Count both signals a fallback can
            // carry — an explicit `parseError` and the rawAnalysis-with-no-
            // findings shape (the fallback's `_fallbackResponse(unit, null,
            // responseText)` call site never sets `parseError`) — without
            // double-counting a unit that happens to have both.
            const parseFailures = perFileFindings.filter(r =>
                r?.parseError || (r?.rawAnalysis && !(r.findings || []).length)
            ).length;

            const accumulatedTokens = results.successful.reduce(
                (acc, r) => ({
                    input: acc.input + (r.data.usage?.input ?? 0),
                    output: acc.output + (r.data.usage?.output ?? 0),
                }),
                { input: 0, output: 0 },
            );
            const failedFiles = results.failed.map(f => {
                const unitIndex = f.index;
                return reviewUnits[unitIndex]?.primaryFile || `unit-${unitIndex}`;
            });

            console.log(`📋 Multi-pass: ${perFileFindings.length} successful, ${failedFiles.length} failed`);

            // A credential failure is not a "failed file" — it is the whole
            // review failing, and it must not be absorbed into `failedFiles`.
            // Left tolerated, every unit fails, `perFileFindings` is empty, and
            // the verdict gate renders "Clean review — no genuine problems
            // found": a green all-clear on a PR that was never read.
            const authFailure = results.failed.find(f => f.isAuthError || isAuthError(f.error));
            if (authFailure) {
                throw markAuthError(new Error(String(authFailure.error)));
            }

            // ── Phase 4: Aggregation ──
            onProgress?.({ phase: 'aggregating', message: 'Synthesizing cross-file analysis...' });

            const commitMessages = (prData.commits || []).map(c =>
                `- ${(c.sha || '').substring(0, 7)}: ${(c.message || '').split('\n')[0]}`
            ).join('\n');

            const aggregationPrompt = buildAggregationPrompt(perFileFindings, {
                prData,
                failedFiles,
                commitMessages
            });

            const aggregationResponse = await this.llmService.streamChat(
                [
                    { role: 'system', content: AGGREGATION_SYSTEM_PROMPT },
                    { role: 'user', content: aggregationPrompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    budgetStage: 'aggregate',
                    budgetPriority: PRIORITY.ESSENTIAL,
                    stream: false
                }
            );

            onProgress?.({ phase: 'complete', message: 'Review complete.' });

            // Add aggregation-call usage to the accumulator built during the
            // per-file pass above.
            const tokenUsage = {
                input: accumulatedTokens.input + (aggregationResponse.usage?.input ?? 0),
                output: accumulatedTokens.output + (aggregationResponse.usage?.output ?? 0),
            };

            return {
                analysis: aggregationResponse.content || aggregationResponse,
                perFileFindings,
                failedFiles,
                reviewUnits: reviewUnits.length,
                processingTime: Date.now() - startTime,
                tokenUsage,
                isMultiPass: true,
                stats: { parseFailures },
                // P0-1: the same failure facts as `failedFiles`/`stats`, in the
                // one shape every downstream path (orchestrator, adapter,
                // handler, cache, API report) reads. `failedFiles` alone was
                // routinely dropped by adapters; a contract that governs the
                // verdict cannot be optional to carry.
                completeness: createCompleteness({
                    expectedUnits: reviewUnits.length,
                    inspectedUnits: perFileFindings.length - parseFailures,
                    parseFailures,
                    failedUnits: failedFiles.map((f) => ({ unit: f, reason: 'unit-failed' })),
                    omissions: budgetOmissions,
                }),
                contextCoverage: {
                    promptFits,
                    omittedHunks: budgetOmissions.filter(o => o.kind === 'diff-budget'),
                },
            };

        } finally {
            clearInterval(keepAlive);
        }
    }

    /**
     * Map static analysis findings by file path
     */
    _groupFindingsByFile(findings) {
        const map = {};
        for (const f of (findings || [])) {
            const key = f.filePath || f.file || 'unknown';
            if (!map[key]) map[key] = [];
            map[key].push(f);
        }
        return map;
    }

    /**
     * Distribute RAG chunks to the files they should inform (max 3 per file).
     *
     * Prefers a `byFile` map built by per-file retrieval upstream: querying the
     * index once per changed file returns chunks that are semantically relevant
     * to THAT file, which is strictly better than retrieving repo-wide and then
     * guessing the mapping from path similarity.
     *
     * The path-similarity fallback below is kept for callers that still pass a
     * flat chunk list — but it no longer DISCARDS chunks that match no file by
     * path. Same-directory matching meant a caller living in another module (the
     * most valuable cross-file context there is) was retrieved and then thrown
     * away. Unmatched chunks are now spread across files with spare capacity.
     */
    _distributeRAGContext(ragContext, files) {
        const map = {};
        if (!ragContext) return map;

        // Per-file retrieval result — authoritative, use as-is.
        if (!Array.isArray(ragContext) && ragContext.byFile && typeof ragContext.byFile === 'object') {
            for (const [filename, chunks] of Object.entries(ragContext.byFile)) {
                if (Array.isArray(chunks) && chunks.length) map[filename] = chunks.slice(0, 3);
            }
            if (Object.keys(map).length > 0) return map;
        }

        // Handle both formatted string and array of chunks
        const chunks = Array.isArray(ragContext)
            ? ragContext
            : (ragContext.chunks && Array.isArray(ragContext.chunks))
                ? ragContext.chunks
                : [];

        if (chunks.length === 0) return map;

        const MAX_PER_FILE = 3;
        const unmatched = [];

        for (const chunk of chunks) {
            const chunkFile = chunk.filePath || chunk.file || '';
            let matched = false;
            for (const f of files) {
                // Match chunk to file if paths overlap
                if (chunkFile && f.filename &&
                    (chunkFile.includes(f.filename) || f.filename.includes(chunkFile) ||
                     this._sameDirectory(chunkFile, f.filename))) {
                    matched = true;
                    if (!map[f.filename]) map[f.filename] = [];
                    if (map[f.filename].length < MAX_PER_FILE) {
                        map[f.filename].push(chunk);
                    }
                }
            }
            if (!matched) unmatched.push(chunk);
        }

        // Retrieval already ranked these as relevant to the change as a whole;
        // give them to files that still have room rather than dropping them.
        for (const chunk of unmatched) {
            const target = files.find(f => f.filename && (map[f.filename]?.length ?? 0) < MAX_PER_FILE);
            if (!target) break;
            (map[target.filename] = map[target.filename] || []).push(chunk);
        }

        return map;
    }

    _sameDirectory(path1, path2) {
        const dir1 = path1.split('/').slice(0, -1).join('/');
        const dir2 = path2.split('/').slice(0, -1).join('/');
        return dir1 && dir2 && dir1 === dir2;
    }

    /**
     * Get RAG chunks relevant to a review unit
     */
    _getRAGChunksForUnit(ragByFile, unit) {
        const chunks = [];
        for (const file of unit.files) {
            const fileChunks = ragByFile[file.filename] || [];
            chunks.push(...fileChunks);
        }
        return chunks.slice(0, 3); // Max 3 chunks per review unit
    }

    /**
     * Get code-graph cross-file context relevant to a review unit.
     * @param {{byFile?: Record<string,string>, combined?: string}} graphContext
     * @param {Object} unit
     * @returns {string}
     */
    _getGraphContextForUnit(graphContext, unit) {
        if (!graphContext || !graphContext.byFile) return '';
        const parts = [];
        for (const file of unit.files) {
            const ctx = graphContext.byFile[file.filename];
            if (ctx) parts.push(`### ${file.filename}\n${ctx}`);
        }
        return parts.join('\n\n');
    }

    /**
     * Get static findings relevant to a review unit
     */
    _getStaticFindingsForUnit(findingsByFile, unit) {
        const findings = [];
        for (const file of unit.files) {
            const fileFindings = findingsByFile[file.filename] || [];
            findings.push(...fileFindings);
        }
        return findings;
    }

    /**
     * Parse structured JSON response from per-file LLM review
     */
    _parsePerFileResponse(responseText, unit) {
        if (!responseText || typeof responseText !== 'string') {
            return this._fallbackResponse(unit, 'Empty response');
        }

        // Try to extract JSON from the response
        let cleaned = responseText.trim();

        // Strip markdown code fences if present
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.slice(7);
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.slice(3);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.slice(0, -3);
        }
        cleaned = cleaned.trim();

        try {
            const parsed = JSON.parse(cleaned);
            if (parsed.findings && Array.isArray(parsed.findings)) {
                return {
                    file: parsed.file || unit.primaryFile,
                    language: parsed.language || unit.files[0]?.language || 'unknown',
                    fileVerdict: parsed.fileVerdict || 'DISCUSS',
                    riskLevel: parsed.riskLevel || 'MEDIUM',
                    findings: parsed.findings,
                    positives: parsed.positives || [],
                    testCoverage: parsed.testCoverage || null
                };
            }
        } catch (e) {
            // Try to find JSON object within the text
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.findings && Array.isArray(parsed.findings)) {
                        return {
                            file: parsed.file || unit.primaryFile,
                            language: parsed.language || unit.files[0]?.language || 'unknown',
                            fileVerdict: parsed.fileVerdict || 'DISCUSS',
                            riskLevel: parsed.riskLevel || 'MEDIUM',
                            findings: parsed.findings,
                            positives: parsed.positives || [],
                            testCoverage: parsed.testCoverage || null
                        };
                    }
                } catch (e2) { /* fall through to fallback */ }
            }
        }

        // Fallback: treat entire response as raw analysis for aggregation to interpret
        return this._fallbackResponse(unit, null, responseText);
    }

    _fallbackResponse(unit, error = null, rawAnalysis = '') {
        return {
            file: unit.primaryFile,
            language: unit.files[0]?.language || 'unknown',
            fileVerdict: 'DISCUSS',
            riskLevel: 'MEDIUM',
            findings: [],
            positives: [],
            testCoverage: null,
            rawAnalysis: rawAnalysis || '',
            parseError: error || undefined
        };
    }
}

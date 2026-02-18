import { BatchProcessor } from '../utils/batchProcessor.js';
import { FileGroupingStrategy } from './FileGroupingStrategy.js';
import {
    PER_FILE_REVIEW_SYSTEM_PROMPT,
    AGGREGATION_SYSTEM_PROMPT,
    buildPerFileReviewPrompt,
    buildAggregationPrompt,
    buildPRContextSummary,
    getLanguageRules
} from '../utils/multiPassPrompts.js';

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
        const { focusAreas = ['security', 'bugs', 'performance', 'style'] } = options;
        const maxConcurrent = options.maxConcurrent || 3;

        // Service worker keepalive — ping every 25s to prevent MV3 termination
        const keepAlive = setInterval(() => {
            try { chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {}); } catch (e) { /* ignore */ }
        }, 25000);

        try {
            // ── Phase 1: Prepare ──
            onProgress?.({ phase: 'preparing', message: 'Preparing review data...' });

            const prContext = buildPRContextSummary(prData);
            const findingsByFile = this._groupFindingsByFile(context.staticFindings || []);
            const ragByFile = this._distributeRAGContext(context.ragContext, prData.files);

            // ── Phase 2: Group files ──
            onProgress?.({ phase: 'grouping', message: 'Grouping files for review...' });

            const groupingStrategy = new FileGroupingStrategy();
            const maxFiles = options.maxFilesToReview || 50;
            const filesToReview = prData.files.slice(0, maxFiles);
            const reviewUnits = groupingStrategy.group(filesToReview, { findingsByFile });

            console.log(`📋 Multi-pass: ${reviewUnits.length} review units from ${filesToReview.length} files`);

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

            const results = await batchProcessor.processBatches(
                [reviewUnits], // Single batch, concurrency handled by semaphore
                async (unit) => {
                    const prompt = buildPerFileReviewPrompt(unit, {
                        prContext,
                        focusAreas,
                        ragChunks: this._getRAGChunksForUnit(ragByFile, unit),
                        staticFindings: this._getStaticFindingsForUnit(findingsByFile, unit),
                        languageRules: getLanguageRules(unit.files[0]?.language)
                    });

                    const response = await this.llmService.streamChat(
                        [
                            { role: 'system', content: PER_FILE_REVIEW_SYSTEM_PROMPT },
                            { role: 'user', content: prompt }
                        ],
                        {
                            provider: settings.provider,
                            model: settings.model,
                            apiKey: settings.apiKey,
                            stream: false
                        }
                    );

                    return this._parsePerFileResponse(response.content || response, unit);
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

            const perFileFindings = results.successful.map(r => r.data);
            const failedFiles = results.failed.map(f => {
                const unitIndex = f.index;
                return reviewUnits[unitIndex]?.primaryFile || `unit-${unitIndex}`;
            });

            console.log(`📋 Multi-pass: ${perFileFindings.length} successful, ${failedFiles.length} failed`);

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
                    stream: false
                }
            );

            onProgress?.({ phase: 'complete', message: 'Review complete.' });

            return {
                analysis: aggregationResponse.content || aggregationResponse,
                perFileFindings,
                failedFiles,
                reviewUnits: reviewUnits.length,
                processingTime: Date.now() - startTime,
                isMultiPass: true
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
     * Distribute RAG chunks to matching files (2-3 per file)
     */
    _distributeRAGContext(ragContext, files) {
        const map = {};
        if (!ragContext) return map;

        // Handle both formatted string and array of chunks
        const chunks = Array.isArray(ragContext)
            ? ragContext
            : (ragContext.chunks && Array.isArray(ragContext.chunks))
                ? ragContext.chunks
                : [];

        if (chunks.length === 0) return map;

        for (const chunk of chunks) {
            const chunkFile = chunk.filePath || chunk.file || '';
            for (const f of files) {
                // Match chunk to file if paths overlap
                if (chunkFile && f.filename &&
                    (chunkFile.includes(f.filename) || f.filename.includes(chunkFile) ||
                     this._sameDirectory(chunkFile, f.filename))) {
                    if (!map[f.filename]) map[f.filename] = [];
                    if (map[f.filename].length < 3) { // Max 3 chunks per file
                        map[f.filename].push(chunk);
                    }
                }
            }
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

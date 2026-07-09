/**
 * PR-review message handlers, extracted from BackgroundService.
 *
 * This is the largest handler domain: full PR analysis (single- and multi-pass),
 * quick summaries, security review, test-automation review, standalone static
 * analysis, posting reviews, hunk-level content-script actions, and full-file
 * fetches. The factory takes the BackgroundService instance (`svc`) and returns
 * the handler map for the router.
 *
 * Shared helpers that remain on the BackgroundService class are accessed via
 * `svc.*` (e.g. svc.updatePRServiceTokens, svc._estimateCost, svc.llmService).
 * The 12 handlers moved here call each other directly as local functions.
 */

import {
    PR_ANALYSIS_SYSTEM_PROMPT,
    buildPRAnalysisPrompt,
    buildPRSummaryPrompt,
    buildSecurityReviewPrompt,
    buildTestAutomationReviewPrompt,
    buildTestAutomationPRReviewPrompt,
    TEST_AUTOMATION_ANALYSIS_PROMPT
} from '../../utils/prompts.js';
import {
    PR_SUMMARY_SYSTEM_PROMPT,
    buildPRSummaryGenerationPrompt
} from '../../utils/prSummaryPrompts.js';
import { MultiPassReviewEngine } from '../../services/MultiPassReviewEngine.js';
import { ReviewOrchestrator } from '../../services/ReviewOrchestrator.js';
import { VERDICT } from '../../services/reviewSchema.js';
import { detectLanguages, buildStandardsBlock } from '../../utils/standardsLoader.js';

/**
 * Adapter: ReviewOrchestrator emits the canonical VerdictReport
 * { schemaVersion, verdict, findings[], summary, counts, meta }.
 * Legacy callers (sendResponse, ReviewMetricsService.recordReview,
 * the popup's CodeReviewView) expect the MultiPassReviewEngine shape
 * { analysis, perFileFindings, failedFiles, reviewUnits, processingTime }.
 *
 * Lossy on purpose — the rich phase/severity/normalization detail is
 * preserved on result._orchestrated for callers that want it.
 */
function adaptOrchestratorReport(report) {
    const SEVERITY_BACK = {
        blocking: 'high',     // map canonical → legacy so downstream
        suggestion: 'medium', // verdict logic (critical|high gating) keeps
        nitpick: 'low',       // working unchanged
    };
    const perFileFindings = (report.findings || []).map((f) => ({
        id: f.id,
        severity: SEVERITY_BACK[f.severity] ?? 'medium',
        type: f.category,
        title: f.title || (f.suggestion || '').split('\n', 1)[0].slice(0, 80),
        message: f.suggestion || '',
        file: f.file,
        line: f.line,
        source: f.source,
        phase: f.phase,
        codeSnippet: f.evidence || null,
    }));
    const analysisParts = [];
    if (report.summary?.deep)      analysisParts.push(`## Deep Review\n\n${report.summary.deep}`);
    if (report.summary?.standards) analysisParts.push(`## Standards Review\n\n${report.summary.standards}`);
    if (report.verdict === VERDICT.SKIP)  analysisParts.push(`\n_Review skipped: ${report.meta?.gate?.reason || 'see meta.gate'}_`);
    if (report.verdict === VERDICT.DEFER) analysisParts.push(`\n_Review deferred: ${report.meta?.gate?.reason || 'see meta.gate'}_`);

    return {
        analysis: analysisParts.join('\n\n'),
        perFileFindings,
        failedFiles: (report.meta?.failedChunks || [])
            .flatMap((c) => c.failedFiles || (c.error ? [{ chunk: c.chunk, error: c.error }] : [])),
        reviewUnits: report.meta?.chunkSummary?.totalChunks ?? 1,
        processingTime: report.meta?.durationMs ?? 0,
        isMultiPass: true,
        verdict: report.verdict,
    };
}

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function|{fn: Function, allowContentScript: boolean}>}
 */
export function createPrReviewHandlers(svc) {
    async function handleAnalyzePullRequest(message, sendResponse) {
        const startedAt = Date.now();
        try {
            const { prUrl, options = {} } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            console.log('📋 Analyzing PR:', prUrl);

            // Update tokens for PR service
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            console.log(`📊 PR fetched: ${prData.files.length} files, +${prData.stats.additions} -${prData.stats.deletions}`);

            // Get RAG context if repo is indexed
            let ragContext = null;
            let repoDocumentation = null;
            const repoId = `${prData.branches?.targetRepo || prData.author?.login}`;
            if (options.useRepoContext !== false) {
                try {
                    const prDescription = `${prData.title} ${prData.description || ''}`;
                    ragContext = await svc.ragService.retrieveContext(
                        repoId,
                        prDescription,
                        20,
                        { formatOutput: true, maxChunksPerFile: 4 }
                    );

                    // Also fetch repository documentation for understanding project context
                    repoDocumentation = await svc.ragService.getRepositoryDocumentation(repoId);
                    if (repoDocumentation.found) {
                        console.log(`📖 PR Review: Found repo documentation from ${repoDocumentation.sources.join(', ')}`);
                    }
                } catch (e) {
                    console.warn('RAG context not available:', e.message);
                }
            }

            // Adaptive-learning context: rules the user has dismissed in this
            // repo. Passed to the prompt so the model deprioritises patterns
            // the team has already rejected.
            let dismissedRules = [];
            try {
                dismissedRules = await svc.adaptiveLearningService
                    .getDismissedRulesSummary(repoId, 10);
                if (dismissedRules.length > 0) {
                    console.log(`🧠 AdaptiveLearning: ${dismissedRules.length} dismissed rule patterns for ${repoId}`);
                }
            } catch (e) {
                console.warn('AdaptiveLearning summary unavailable:', e.message);
            }

            // Detect if this is a test automation repo/PR
            const isTestAutomationPR = svc.isTestAutomationPR(prData);

            // Build appropriate prompt
            let systemPrompt, userPrompt;

            // Include repository documentation in context if found
            const contextWithDocs = {
                ragContext,
                repoDocumentation: repoDocumentation?.found ? repoDocumentation.content : null,
                repoDocSources: repoDocumentation?.found ? repoDocumentation.sources : [],
                dismissedRules
            };

            if (isTestAutomationPR && options.mode !== 'general') {
                // Use test automation specific review
                systemPrompt = TEST_AUTOMATION_ANALYSIS_PROMPT;
                userPrompt = buildTestAutomationPRReviewPrompt(prData, contextWithDocs);
            } else if (options.mode === 'security') {
                // Security-focused review
                const highRiskFiles = svc.pullRequestService.getHighRiskFiles(prData);
                systemPrompt = PR_ANALYSIS_SYSTEM_PROMPT;
                userPrompt = buildSecurityReviewPrompt(prData, highRiskFiles, contextWithDocs);
            } else {
                // General comprehensive review
                systemPrompt = PR_ANALYSIS_SYSTEM_PROMPT;
                // #19 — build language-aware standards block in background (not in prompts.js)
                const prLangs = detectLanguages(prData.files);
                const standardsBlock = buildStandardsBlock(prLangs, prData.files);
                userPrompt = buildPRAnalysisPrompt(prData, {
                    focusAreas: options.focusAreas || ['security', 'bugs', 'performance', 'style'],
                    maxFilesToReview: options.maxFiles || 100,
                    includeTestAnalysis: options.includeTestAnalysis !== false,
                    standardsBlock: { ...standardsBlock, langs: [...prLangs] },
                    ...contextWithDocs
                });
            }

            // Get LLM settings
            const settings = await svc.getStoredSettings();

            // Apply repo-pinned model from .repospector.yaml if present.
            const pinnedModel = options.customConfig?.settings?.model;
            const effectiveModel = pinnedModel || settings.model;
            if (pinnedModel && pinnedModel !== settings.model) {
                console.log(`🎯 Using model pinned by .repospector.yaml: ${pinnedModel}`);
            }

            // Stream the analysis
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                {
                    provider: settings.provider,
                    model: effectiveModel,
                    apiKey: settings.apiKey,
                    stream: false // For now, return full response
                }
            );

            // #22 — Parse BLOCKING count from summary to compute mechanical verdict.
            const analysisText = response.content || response || '';
            const blockingMatch = analysisText.match(/BLOCKING:\s*(\d+)/i);
            const blockingCount = blockingMatch ? parseInt(blockingMatch[1], 10) : 0;
            const reviewVerdict = blockingCount > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
            // Map verdict → GitHub/GitLab post-review event field
            const reviewEvent = blockingCount > 0 ? 'REQUEST_CHANGES' : 'APPROVE';

            // Telemetry: record this run (no-op when telemetry is disabled).
            try {
                await svc.telemetry.record({
                    kind: 'pr_review',
                    durationMs: Date.now() - startedAt,
                    tokensIn: response.usage?.prompt_tokens || 0,
                    tokensOut: response.usage?.completion_tokens || 0,
                    costUsd: svc._estimateCost(effectiveModel, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0),
                    model: effectiveModel,
                });
            } catch (e) { /* never let telemetry break a review */ }

            sendResponse({
                success: true,
                data: {
                    analysis: analysisText,
                    reviewVerdict,
                    reviewEvent,
                    blockingCount,
                    prSummary: svc.pullRequestService.generatePRSummary(prData),
                    prData: {
                        title: prData.title,
                        state: prData.state,
                        author: prData.author,
                        stats: prData.stats,
                        files: prData.files.map(f => ({
                            filename: f.filename,
                            status: f.status,
                            additions: f.additions,
                            deletions: f.deletions,
                            language: f.language
                        })),
                        url: prData.url
                    },
                    isTestAutomationPR
                }
            });
        } catch (error) {
            svc.errorHandler.logError('PR Analysis', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Get quick PR summary
     */
    async function handleGetPRSummary(message, sendResponse) {
        try {
            const { prUrl } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            // Update tokens
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);

            // Build summary prompt
            const prompt = buildPRSummaryPrompt(prData);

            // Get settings
            const settings = await svc.getStoredSettings();

            // Get quick summary from LLM
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: 'You are a helpful code reviewer. Provide concise, actionable summaries.' },
                    { role: 'user', content: prompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            sendResponse({
                success: true,
                data: {
                    summary: response.content || response,
                    prData: svc.pullRequestService.generatePRSummary(prData),
                    highRiskFiles: svc.pullRequestService.getHighRiskFiles(prData)
                }
            });
        } catch (error) {
            svc.errorHandler.logError('PR Summary', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Security-focused PR review
     */
    async function handleSecurityReviewPR(message, sendResponse) {
        try {
            const { prUrl } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            console.log('🔒 Security review for PR:', prUrl);

            // Update tokens
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            const highRiskFiles = svc.pullRequestService.getHighRiskFiles(prData);

            console.log(`🔍 Found ${highRiskFiles.length} high-risk files`);

            // Build security review prompt
            const prompt = buildSecurityReviewPrompt(prData, highRiskFiles);

            // Get settings
            const settings = await svc.getStoredSettings();

            // Get security analysis
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: PR_ANALYSIS_SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            sendResponse({
                success: true,
                data: {
                    securityAnalysis: response.content || response,
                    highRiskFiles: highRiskFiles.map(f => ({
                        filename: f.filename,
                        riskReasons: f.riskReasons,
                        additions: f.additions,
                        deletions: f.deletions
                    })),
                    prData: {
                        title: prData.title,
                        url: prData.url,
                        stats: prData.stats
                    }
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Security Review', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Review test automation code
     */
    async function handleReviewTestAutomation(message, sendResponse) {
        try {
            const { code, context = {} } = message.data || message.payload || {};

            if (!code) {
                sendResponse({ success: false, error: 'Code is required' });
                return;
            }

            console.log('🧪 Reviewing test automation code');

            // Build test automation review prompt
            const prompt = buildTestAutomationReviewPrompt(code, context);

            // Get settings
            const settings = await svc.getStoredSettings();

            // Get analysis
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: TEST_AUTOMATION_ANALYSIS_PROMPT },
                    { role: 'user', content: prompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            sendResponse({
                success: true,
                data: {
                    review: response.content || response,
                    framework: context.framework || 'auto-detected'
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Test Automation Review', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Run static analysis on code
     */
    async function handleRunStaticAnalysis(message, sendResponse) {
        try {
            const { code, filePath, options = {} } = message.data || message.payload || {};

            if (!code) {
                sendResponse({ success: false, error: 'Code is required' });
                return;
            }

            console.log('🔍 Running static analysis on:', filePath || 'code snippet');

            const result = await svc.staticAnalysisService.analyzeFile(code, {
                filePath: filePath || 'unknown.js',
                ...options
            });

            sendResponse({
                success: true,
                data: result
            });
        } catch (error) {
            svc.errorHandler.logError('Static Analysis', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Analyze PR with static analysis followed by LLM review
     * This runs static analysis first, then injects findings into the LLM prompt
     */
    async function handleAnalyzePRWithStaticAnalysis(message, sendResponse) {
        try {
            const { prUrl, options = {} } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            console.log('📋 Analyzing PR with static analysis:', prUrl);

            // Clear cached scores if force refresh is requested
            if (options.forceRefresh) {
                svc.prScoreCache.delete(prUrl);
            }

            // Update tokens for PR service
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            console.log(`📊 PR fetched: ${prData.files.length} files, +${prData.stats.additions} -${prData.stats.deletions}`);

            // Step 1: Run static analysis on changed files
            console.log('🔍 Running static analysis on PR files...');
            // Load review quality settings
            const settings = await svc.getStoredSettings();
            const reviewSettings = settings.reviewSettings || {};

            // Derive repoId from PR data for adaptive learning
            const repoId = prData.branches?.targetRepo ||
                `${prData.author?.login || 'unknown'}/${prData.title || 'unknown'}`;

            // Detect platform and parse owner/repo from PR URL
            let customConfig = null;
            try {
                const urlMatch = prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+)\/([^/]+)/);
                if (urlMatch) {
                    const platform = prUrl.includes('gitlab.com') ? 'gitlab' : 'github';
                    const owner = urlMatch[1];
                    const repo = urlMatch[2];
                    const token = platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
                    customConfig = await svc.customRulesService.fetchConfig(platform, owner, repo, token);
                }
            } catch (e) {
                console.warn('Failed to fetch custom config:', e.message);
            }

            const staticAnalysisResult = await svc.staticAnalysisService.analyzePullRequest(prData, {
                enableESLint: options.enableESLint !== false,
                enableSemgrep: options.enableSemgrep !== false,
                enableDependency: options.enableDependency !== false,
                severityThreshold: options.severityThreshold || reviewSettings.severityThreshold || 'all',
                groupRelatedFindings: options.groupRelatedFindings ?? reviewSettings.groupRelatedFindings ?? true,
                repoId,
                customConfig
            });

            console.log(`📊 Static analysis found ${staticAnalysisResult.totalFindings} issues`);

            // Compute deterministic scores and cache them for consistency
            const reviewEffort = svc.pullRequestService.estimateReviewEffort(prData);
            const riskScore = staticAnalysisResult.riskScore;

            // Cache scores by PR URL so repeated analyses return the same values
            if (!svc.prScoreCache.has(prUrl)) {
                svc.prScoreCache.set(prUrl, { reviewEffort, riskScore });
            }
            const cachedScores = svc.prScoreCache.get(prUrl);

            // Get RAG context if repo is indexed
            let ragContext = null;
            if (options.useRepoContext !== false) {
                try {
                    const prDescription = `${prData.title} ${prData.description || ''}`;
                    ragContext = await svc.ragService.retrieveContext(
                        repoId,
                        prDescription,
                        20,
                        { formatOutput: true, maxChunksPerFile: 4 }
                    );
                } catch (e) {
                    console.warn('RAG context not available:', e.message);
                }
            }

            // Step 2: Build enhanced prompt with static analysis findings
            const staticAnalysisContext = svc.staticAnalysisService.formatFindingsForPrompt(
                staticAnalysisResult.findings,
                options.maxStaticFindings || 15
            );

            // Detect if this is a test automation repo/PR
            const isTestAutomationPR = svc.isTestAutomationPR(prData);

            // Build appropriate prompt
            let systemPrompt, userPrompt;

            if (isTestAutomationPR && options.mode !== 'general') {
                systemPrompt = TEST_AUTOMATION_ANALYSIS_PROMPT;
                userPrompt = buildTestAutomationPRReviewPrompt(prData, { ragContext });
            } else if (options.mode === 'security') {
                const highRiskFiles = svc.pullRequestService.getHighRiskFiles(prData);
                systemPrompt = PR_ANALYSIS_SYSTEM_PROMPT;
                userPrompt = buildSecurityReviewPrompt(prData, highRiskFiles);
            } else {
                // Adaptive-learning context (same as standard analyze path).
                let dismissedRules = [];
                try {
                    dismissedRules = await svc.adaptiveLearningService
                        .getDismissedRulesSummary(repoId, 10);
                } catch (e) {
                    console.warn('AdaptiveLearning summary unavailable:', e.message);
                }
                systemPrompt = PR_ANALYSIS_SYSTEM_PROMPT;
                userPrompt = buildPRAnalysisPrompt(prData, {
                    focusAreas: options.focusAreas || ['security', 'bugs', 'performance', 'style'],
                    maxFilesToReview: options.maxFiles || 100,
                    includeTestAnalysis: options.includeTestAnalysis !== false,
                    ragContext,
                    dismissedRules
                });
            }

            // Inject static analysis findings into the prompt
            if (staticAnalysisContext) {
                userPrompt = `${staticAnalysisContext}\n\n---\n\n${userPrompt}`;
            }

            // Step 3: Get LLM analysis
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            // Generate AI summary
            let aiSummary = null;
            try {
                const summaryPrompt = buildPRSummaryGenerationPrompt(
                    prData,
                    staticAnalysisResult.summary
                );
                const summaryResponse = await svc.llmService.streamChat(
                    [
                        { role: 'system', content: PR_SUMMARY_SYSTEM_PROMPT },
                        { role: 'user', content: summaryPrompt }
                    ],
                    {
                        provider: settings.provider,
                        model: settings.model,
                        apiKey: settings.apiKey,
                        stream: false
                    }
                );
                aiSummary = summaryResponse.content || summaryResponse;
            } catch (e) {
                console.warn('Failed to generate PR summary:', e.message);
            }

            sendResponse({
                success: true,
                data: {
                    analysis: response.content || response,
                    aiSummary,
                    staticAnalysis: {
                        findings: staticAnalysisResult.findings,
                        summary: staticAnalysisResult.summary,
                        riskScore: cachedScores.riskScore,
                        recommendation: staticAnalysisResult.recommendation
                    },
                    prSummary: svc.pullRequestService.generatePRSummary(prData),
                    reviewEffort: cachedScores.reviewEffort,
                    prData: {
                        title: prData.title,
                        state: prData.state,
                        author: prData.author,
                        stats: prData.stats,
                        files: prData.files.map(f => ({
                            filename: f.filename,
                            status: f.status,
                            additions: f.additions,
                            deletions: f.deletions,
                            language: f.language
                        })),
                        url: prData.url
                    },
                    isTestAutomationPR
                }
            });
        } catch (error) {
            svc.errorHandler.logError('PR Analysis with Static Analysis', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Multi-pass PR review: per-file analysis → cross-file aggregation.
     * Falls back to single-pass for small PRs (≤5 files).
     */
    async function handleMultiPassPRReview(message, sendResponse) {
        try {
            const { prUrl, options = {} } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            console.log('📋 Multi-pass PR review:', prUrl);
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            console.log(`📊 PR fetched: ${prData.files.length} files, +${prData.stats.additions} -${prData.stats.deletions}`);

            // Enhance files with full content if enabled (not just patch lines)
            if (options.fetchFullFiles !== false) {
                try {
                    const headRef = prData.branches?.source;
                    prData.files = await svc.pullRequestService.enhanceFilesWithFullContent(
                        prUrl, prData.files,
                        { maxFiles: options.maxFullFiles || 10, ref: headRef }
                    );
                    const enhanced = prData.files.filter(f => f.fullContent).length;
                    if (enhanced > 0) {
                        console.log(`📄 Enhanced ${enhanced} files with full content for deeper review`);
                    }
                } catch (enhanceErr) {
                    console.warn('Failed to enhance files with full content:', enhanceErr.message);
                }
            }

            // Fallback to single-pass for small PRs
            const FILE_THRESHOLD = options.multiPassThreshold || 3;
            if (prData.files.length <= FILE_THRESHOLD) {
                console.log(`📋 PR has ${prData.files.length} files (≤${FILE_THRESHOLD}), using single-pass`);
                return handleAnalyzePRWithStaticAnalysis(message, sendResponse);
            }

            const multiPassStartedAt = Date.now();
            const settings = await svc.getStoredSettings();
            const reviewSettings = settings.reviewSettings || {};
            const repoId = prData.branches?.targetRepo ||
                `${prData.author?.login || 'unknown'}/${prData.title || 'unknown'}`;

            // #16b — honour model pin from .repospector.yaml in multi-pass path
            let customConfig = null;
            try {
                const urlMatch = prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+)\/([^/]+)/);
                if (urlMatch) {
                    const platform = prUrl.includes('gitlab.com') ? 'gitlab' : 'github';
                    const owner = urlMatch[1];
                    const repo = urlMatch[2];
                    const token = platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
                    customConfig = await svc.customRulesService.fetchConfig(platform, owner, repo, token);
                }
            } catch (e) {
                console.warn('Failed to fetch custom config:', e.message);
            }

            // Gather context in parallel
            const [ragContext, repoDocumentation, staticResult] = await Promise.all([
                svc._fetchRAGContextForMultiPass(repoId, prData, options),
                svc._fetchRepoDocForMultiPass(repoId, options),
                svc.staticAnalysisService.analyzePullRequest(prData, {
                    enableESLint: options.enableESLint !== false,
                    enableSemgrep: options.enableSemgrep !== false,
                    enableDependency: options.enableDependency !== false,
                    severityThreshold: options.severityThreshold || reviewSettings.severityThreshold || 'all',
                    groupRelatedFindings: options.groupRelatedFindings ?? reviewSettings.groupRelatedFindings ?? true,
                    repoId,
                    customConfig
                })
            ]);

            console.log(`📊 Static analysis found ${staticResult.totalFindings} issues`);

            // Cache deterministic scores
            const reviewEffort = svc.pullRequestService.estimateReviewEffort(prData);
            if (!svc.prScoreCache.has(prUrl)) {
                svc.prScoreCache.set(prUrl, { reviewEffort, riskScore: staticResult.riskScore });
            }
            const cachedScores = svc.prScoreCache.get(prUrl);

            // Progress callback
            const onProgress = (event) => {
                try {
                    chrome.runtime.sendMessage({
                        type: 'PR_REVIEW_PROGRESS',
                        data: event
                    }).catch(() => { });
                } catch (e) { /* popup may be closed */ }
            };

            // #16b — apply model pin from .repospector.yaml
            const multiPassPinnedModel = customConfig?.settings?.model;
            const multiPassModel = multiPassPinnedModel || settings.model;
            if (multiPassPinnedModel && multiPassPinnedModel !== settings.model) {
                console.log(`🎯 Using model pinned by .repospector.yaml: ${multiPassPinnedModel}`);
            }

            // Execute review — orchestrated pipeline (Bastion-style: skip rules +
            // chunking + assigned-hunks normalization) when the feature flag is on,
            // legacy multi-pass otherwise. The flag is opt-in for now so the new
            // pipeline can be validated against real PRs side-by-side before
            // becoming the default.
            const engine = new MultiPassReviewEngine({
                llmService: svc.llmService,
                ragService: svc.ragService
            });

            const useOrchestrator = settings.experimental?.orchestratedReview === true
                || reviewSettings.orchestratedReview === true;

            const reviewContext = {
                ragContext,
                repoDocumentation: repoDocumentation?.found ? repoDocumentation.content : null,
                staticFindings: staticResult.findings,
                isTestAutomationPR: svc.isTestAutomationPR(prData)
            };
            const reviewSettings_ = {
                provider: settings.provider,
                model: multiPassModel,
                apiKey: settings.apiKey
            };
            const reviewOptions = {
                focusAreas: options.focusAreas || ['security', 'bugs', 'performance', 'style'],
                maxConcurrent: options.maxConcurrent || 3,
                maxFilesToReview: options.maxFiles || 50
            };

            // Backend dispatch (Aegis) is currently disabled — the third-party
            // backend surface is hidden from the UI and the dispatch logic
            // removed. `AegisClient` import + `apps/api` remain in the
            // repository for future re-enable; see docs/adr/0001-backend-service.md.
            let result;

            if (!result) {
                if (useOrchestrator) {
                    console.log('🧭 Orchestrator path: skip-rules → chunking → deep+standards → normalize');
                    const orchestrator = new ReviewOrchestrator({
                        multiPassEngine: engine,
                        findingCache: svc.findingCache,
                        telemetry: svc.telemetry
                    });
                    const report = await orchestrator.review(
                        prData, reviewContext, reviewSettings_, reviewOptions, onProgress
                    );
                    result = adaptOrchestratorReport(report);
                    result._orchestrated = report;
                    onProgress?.({ phase: 'complete', message: 'Review complete.', orchestrated: true });
                } else {
                    result = await engine.execute(
                        prData, reviewContext, reviewSettings_, reviewOptions, onProgress
                    );
                }
            }

            // Generate AI summary
            let aiSummary = null;
            try {
                const summaryPrompt = buildPRSummaryGenerationPrompt(
                    prData,
                    staticResult.summary
                );
                const summaryResponse = await svc.llmService.streamChat(
                    [
                        { role: 'system', content: PR_SUMMARY_SYSTEM_PROMPT },
                        { role: 'user', content: summaryPrompt }
                    ],
                    {
                        provider: settings.provider,
                        model: settings.model,
                        apiKey: settings.apiKey,
                        stream: false
                    }
                );
                aiSummary = summaryResponse.content || summaryResponse;
            } catch (e) {
                console.warn('Failed to generate PR summary:', e.message);
            }

            // Record review metrics
            try {
                await svc.reviewMetricsService.recordReview({
                    repoId,
                    prUrl,
                    findings: result.perFileFindings || [],
                    staticFindings: staticResult.findings || [],
                    reviewType: 'multi-pass',
                    filesReviewed: prData.files.length
                });
            } catch (metricsErr) {
                console.warn('Failed to record review metrics:', metricsErr.message);
            }

            // Telemetry for multi-pass (no-op when disabled)
            try {
                const totalTokensIn = (result.tokenUsage?.input || 0);
                const totalTokensOut = (result.tokenUsage?.output || 0);
                await svc.telemetry.record({
                    kind: 'pr_review',
                    durationMs: Date.now() - multiPassStartedAt,
                    tokensIn: totalTokensIn,
                    tokensOut: totalTokensOut,
                    costUsd: svc._estimateCost(multiPassModel, totalTokensIn, totalTokensOut),
                    model: multiPassModel,
                });
            } catch (e) { /* never let telemetry break a review */ }

            // #22 — mechanical verdict from multi-pass findings
            const allFindings = [...(result.perFileFindings || []), ...(staticResult.findings || [])];
            const multiPassBlocking = allFindings.filter(f =>
                f.severity === 'critical' || f.severity === 'high'
            ).length;
            const multiPassVerdict = multiPassBlocking > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
            const multiPassReviewEvent = multiPassBlocking > 0 ? 'REQUEST_CHANGES' : 'APPROVE';

            sendResponse({
                success: true,
                data: {
                    analysis: result.analysis,
                    reviewVerdict: multiPassVerdict,
                    reviewEvent: multiPassReviewEvent,
                    blockingCount: multiPassBlocking,
                    aiSummary,
                    isMultiPass: true,
                    perFileFindings: result.perFileFindings,
                    failedFiles: result.failedFiles,
                    reviewUnits: result.reviewUnits,
                    processingTime: result.processingTime,
                    staticAnalysis: {
                        findings: staticResult.findings,
                        summary: staticResult.summary,
                        riskScore: cachedScores.riskScore,
                        recommendation: staticResult.recommendation
                    },
                    prSummary: svc.pullRequestService.generatePRSummary(prData),
                    reviewEffort: cachedScores.reviewEffort,
                    prData: {
                        title: prData.title,
                        state: prData.state,
                        author: prData.author,
                        stats: prData.stats,
                        files: prData.files.map(f => ({
                            filename: f.filename,
                            status: f.status,
                            additions: f.additions,
                            deletions: f.deletions,
                            language: f.language
                        })),
                        url: prData.url
                    },
                    isTestAutomationPR: svc.isTestAutomationPR(prData)
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Multi-pass PR Review', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    async function handlePostPRReview(message, sendResponse) {
        try {
            const { prUrl, analysisResult, aiSummary, options = {}, action, description } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            // Handle PR description update action
            if (action === 'update_description' && description) {
                const settings = await svc.getStoredSettings();
                const reviewSettings = settings.reviewSettings || {};
                if (!reviewSettings.enableUpdatePRDescription) {
                    sendResponse({ success: false, error: 'PR description updates are disabled. Enable "Update PR Description" in Settings > Write Features.' });
                    return;
                }
                await svc.updatePRServiceTokens();
                await svc.pullRequestService.updatePRDescription(prUrl, description);
                sendResponse({ success: true, data: { updated: true } });
                return;
            }

            // Check if PR comment posting is enabled
            const settings = await svc.getStoredSettings();
            const reviewSettings = settings.reviewSettings || {};
            if (reviewSettings.enablePRComments === false) {
                sendResponse({ success: false, error: 'PR comment posting is disabled in Settings' });
                return;
            }

            // Update tokens
            await svc.updatePRServiceTokens();

            // Format the review summary
            const summaryBody = svc.pullRequestService.formatReviewSummary(
                analysisResult,
                aiSummary,
                { maxFindings: options.maxFindings || 10 }
            );

            // Generate one-click fix suggestions for high/critical findings
            let findings = analysisResult?.findings || [];
            if (options.generateFixes !== false) {
                try {
                    findings = await svc.pullRequestService.generateFixSuggestions(
                        findings, svc.llmService, settings
                    );
                } catch (e) {
                    console.warn('Fix suggestion generation failed:', e.message);
                }
            }

            // Format inline comments from findings (with suggestion syntax for fixes)
            const inlineComments = options.includeInlineComments !== false
                ? svc.pullRequestService.formatInlineComments(
                    findings,
                    { maxInlineComments: options.maxInlineComments || 15 }
                )
                : [];

            // Post the review
            const result = await svc.pullRequestService.postReview(prUrl, {
                summary: summaryBody,
                inlineComments,
                event: options.event || 'COMMENT' // COMMENT, APPROVE, REQUEST_CHANGES
            });

            console.log(`✅ Posted PR review: ${result.commentsPosted} inline comments, summary: ${result.hasSummary}`);

            sendResponse({
                success: true,
                data: result
            });
        } catch (error) {
            svc.errorHandler.logError('Post PR Review', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    async function handleExplainHunk(message, sendResponse) {
        try {
            const { code, language, file } = message.payload || message.data || {};
            if (!code) {
                sendResponse({ success: false, error: 'code is required' });
                return;
            }
            const sys = 'You are a senior code reviewer. Explain what a code change does in 3-5 sentences. Focus on intent, side effects, and risk. Plain prose, no headings.';
            const user = `File: ${file || 'unknown'}\nLanguage: ${language || 'unknown'}\n\nDiff hunk:\n\`\`\`\n${code}\n\`\`\`\n\nExplain this change.`;
            const text = await svc._runHunkPrompt(sys, user);
            sendResponse({ success: true, text });
        } catch (error) {
            svc.errorHandler.logError('Explain hunk', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleSuggestFixHunk(message, sendResponse) {
        try {
            const { code, language, file } = message.payload || message.data || {};
            if (!code) {
                sendResponse({ success: false, error: 'code is required' });
                return;
            }
            const sys = 'You are a senior code reviewer. Identify the single most important issue in this diff hunk and propose a concrete fix. Format: 1-line problem statement, then a minimal corrected code snippet, then 1-line rationale. If there is no real issue, say "No issues found." and stop.';
            const user = `File: ${file || 'unknown'}\nLanguage: ${language || 'unknown'}\n\nDiff hunk:\n\`\`\`\n${code}\n\`\`\``;
            const text = await svc._runHunkPrompt(sys, user);
            sendResponse({ success: true, text });
        } catch (error) {
            svc.errorHandler.logError('Suggest fix hunk', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handlePostInlineComment(message, sendResponse) {
        try {
            const { prUrl, path, line, body } = message.payload || message.data || {};
            if (!prUrl || !path || !body || !line) {
                sendResponse({ success: false, error: 'prUrl, path, line, body all required' });
                return;
            }
            await svc.updatePRServiceTokens();
            const result = await svc.pullRequestService.postReview(prUrl, {
                summary: '',
                inlineComments: [{ path, line, body }],
                event: 'COMMENT'
            });
            sendResponse({ success: true, data: result });
        } catch (error) {
            svc.errorHandler.logError('Post inline comment', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle fetching full file content (not just patch)
     */
    async function handleFetchFullFile(message, sendResponse) {
        const { repoId, filePath, platform, ref } = message.payload || message.data || {};

        try {
            const settings = await svc.getStoredSettings();
            let content;

            if (platform === 'github') {
                const token = settings.githubToken;
                const url = `https://api.github.com/repos/${repoId}/contents/${encodeURIComponent(filePath)}${ref ? `?ref=${ref}` : ''}`;
                const headers = {
                    'Accept': 'application/vnd.github.v3.raw',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                };
                const resp = await fetch(url, { headers });
                if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
                content = await resp.text();
            } else if (platform === 'gitlab') {
                const token = settings.gitlabToken;
                const projectPath = encodeURIComponent(repoId);
                const encodedPath = encodeURIComponent(filePath);
                const url = `https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodedPath}/raw${ref ? `?ref=${ref}` : '?ref=main'}`;
                const headers = token ? { 'PRIVATE-TOKEN': token } : {};
                const resp = await fetch(url, { headers });
                if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
                content = await resp.text();
            } else {
                throw new Error(`Unsupported platform: ${platform}`);
            }

            sendResponse({ success: true, data: { content, filePath } });
        } catch (error) {
            console.error('Full file fetch error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        ANALYZE_PULL_REQUEST: (m, send) => handleAnalyzePullRequest(m, send),
        GET_PR_SUMMARY: (m, send) => handleGetPRSummary(m, send),
        SECURITY_REVIEW_PR: (m, send) => handleSecurityReviewPR(m, send),
        REVIEW_TEST_AUTOMATION: (m, send) => handleReviewTestAutomation(m, send),
        ANALYZE_PR_WITH_STATIC_ANALYSIS: (m, send) => handleAnalyzePRWithStaticAnalysis(m, send),
        MULTI_PASS_PR_REVIEW: (m, send) => handleMultiPassPRReview(m, send),
        RUN_STATIC_ANALYSIS: (m, send) => handleRunStaticAnalysis(m, send),
        POST_PR_REVIEW: (m, send) => handlePostPRReview(m, send),
        FETCH_FULL_FILE: (m, send) => handleFetchFullFile(m, send),
        EXPLAIN_HUNK: { fn: (m, send) => handleExplainHunk(m, send), allowContentScript: true },
        SUGGEST_FIX_HUNK: { fn: (m, send) => handleSuggestFixHunk(m, send), allowContentScript: true },
        POST_INLINE_COMMENT: { fn: (m, send) => handlePostInlineComment(m, send), allowContentScript: true },
    };
}

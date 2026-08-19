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
import { FindingVerificationService } from '../../services/FindingVerificationService.js';
import { FixRecommendationService } from '../../services/FixRecommendationService.js';
import { SuggestionScorer } from '../../services/SuggestionScorer.js';
import { ReviewGraphContextService } from '../../services/ReviewGraphContextService.js';
import { scanAddedTodos, renderTodoSection } from '../../utils/todoScanner.js';
import { suggestSplit, renderSplitSuggestion } from '../../utils/prSplitSuggester.js';
import { MultiFinderService } from '../../services/MultiFinderService.js';
import { ReviewReuseContextService } from '../../services/ReviewReuseContextService.js';
import { RepoExplorerService } from '../../services/RepoExplorerService.js';
import { freshFindings } from '../../utils/findingDedup.js';
import { assessGraphCoverage, graphCoverageWarning } from '../../utils/graphCoverage.js';
import { shouldExplore } from '../../utils/modelCapabilities.js';
import { LLMService } from '../../services/LLMService.js';
import { OffscreenLintService } from '../../services/OffscreenLintService.js';
import { ReviewCrossRepoService } from '../../services/ReviewCrossRepoService.js';
import { buildBrief } from '../../services/MRChunker.js';
import { StandardsSyncService, mergeStandards } from '../../services/StandardsSyncService.js';
import { enforceCitations } from '../../utils/citationEnforcer.js';
import { buildCanonicalFindings, countBlocking } from '../../utils/findingsFlatten.js';
import { REVIEW_MODE, IncrementalReviewService } from '../../services/IncrementalReviewService.js';
import { resolveModel } from '../../utils/modelResolver.js';
import { ConventionMiner } from '../../services/ConventionMiner.js';
import { CONVENTION_WARM_DEADLINE_MS } from '../../utils/constants.js';
import {
    partitionForPosting,
    renderDeferredSections,
    renderEscalationSection,
    renderPolicyNote
} from '../../utils/reviewPostingPolicy.js';
import { collectPriorBotComments, suppressAlreadyPosted } from '../../utils/commentDedupe.js';
import { stripFeedbackFooter } from '../../utils/feedbackFooter.js';
import { ReviewFileContextService } from '../../services/ReviewFileContextService.js';
import { buildIntentBlock } from '../../utils/reviewIntentContext.js';
import { LinkedIssueService } from '../../services/LinkedIssueService.js';
import { resolveBudget } from '../../utils/reviewContextBudget.js';
import { FeedbackCollectorService } from '../../services/FeedbackCollectorService.js';
import {
    ReviewCacheService,
    CACHE_STATUS,
    renderPrimingContext
} from '../../services/ReviewCacheService.js';
import { detectPlatformOrGitHub, gitlabApiBase, githubApiBase, parseRepoRef } from '../../utils/gitHosts.js';

/**
 * Load `.repospector.yaml` for the repo a PR/MR belongs to.
 *
 * Both call sites used to inline `prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+)\/([^/]+)/)`,
 * which never matched a self-hosted GitLab URL and mis-parsed subgroup paths — so
 * repo config (custom rules, model pin, severity floor, cross-repo workspace) was
 * silently unavailable to most enterprise GitLab users. One helper, host-aware.
 *
 * @returns {Promise<object|null>} validated config, or null when there is none
 */
async function loadRepoConfig(svc, prUrl, settings) {
    try {
        const ref = parseRepoRef(prUrl);
        if (!ref) {
            console.warn(`Could not identify a repo in ${prUrl}; skipping .repospector.yaml`);
            return null;
        }
        const token = ref.platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
        const apiBase = ref.platform === 'github' ? githubApiBase(prUrl) : gitlabApiBase(prUrl);
        return await svc.customRulesService.fetchConfig(
            ref.platform, ref.owner, ref.repo, token,
            { projectPath: ref.projectPath, apiBase },
        );
    } catch (e) {
        console.warn('Failed to fetch custom config:', e.message);
        return null;
    }
}

/**
 * Load the repo's own `AGENTS.md` / `CLAUDE.md` as review context.
 *
 * Most repos already state their conventions in one of these for their own
 * coding agents. Reviewing against generic standards while that file sits one
 * fetch away was leaving the best available signal on the table.
 *
 * Reuses `parseRepoRef` for the same reason `loadRepoConfig` does: inline URL
 * regexes here never matched self-hosted GitLab and mis-parsed subgroups.
 *
 * @returns {Promise<string>} prompt-ready text, or '' when the repo has none
 */
async function loadRepoInstructions(svc, prUrl, settings) {
    try {
        if (!svc.repoInstructionsService) return '';
        const ref = parseRepoRef(prUrl);
        if (!ref) return '';
        const token = ref.platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
        const apiBase = ref.platform === 'github' ? githubApiBase(prUrl) : gitlabApiBase(prUrl);
        const { context, files } = await svc.repoInstructionsService.getInstructions({
            platform: ref.platform,
            owner: ref.owner,
            repo: ref.repo,
            projectPath: ref.projectPath,
            apiBase,
            token,
        });
        if (files.length) {
            console.log(`📜 Repo instruction files applied: ${files.join(', ')}`);
        }
        return context || '';
    } catch (e) {
        // Non-fatal by design: a review without the repo's conventions is far
        // better than no review.
        console.warn('Repo instructions (non-fatal):', e?.message);
        return '';
    }
}

/**
 * Repository URL for a PR/MR URL — everything before the `/pull/` or
 * `/merge_requests/` route. Used to fetch the repo tree for indexing.
 */
function repoUrlFromPrUrl(prUrl) {
    return String(prUrl).split(/\/(?:pull|pull-requests|-\/merge_requests|merge_requests)\//)[0];
}

/**
 * The ticket this PR says it implements, or null.
 *
 * Kept soft and out of the critical path: a tracker that is unreachable,
 * private, or simply not referenced must cost the review nothing. Every failure
 * mode collapses to null and the reviewer proceeds on the diff alone, which is
 * exactly what it did before this lookup existed.
 */
async function resolveLinkedIssue(svc, prUrl, prData) {
    try {
        const prs = svc.pullRequestService;
        const prInfo = prs.parsePullRequestUrl(prUrl);
        if (!prInfo) return null;

        // Reuse the tokens updatePRServiceTokens already resolved for this run
        // rather than reading storage a second time.
        // Jira credentials are optional and read fresh: a team that configures
        // them mid-session should not have to reload the extension.
        const stored = await svc.getStoredSettings();
        // No githubBaseUrl/gitlabBaseUrl override here: passing the constructor-time
        // default would pin every lookup to the public host regardless of which
        // instance this PR is actually on. `fetchForPR` resolves per-URL instead.
        const service = new LinkedIssueService({
            githubToken: prs.githubToken,
            gitlabToken: prs.gitlabToken,
            jiraBaseUrl: stored.jiraBaseUrl,
            jiraEmail: stored.jiraEmail,
            jiraToken: stored.jiraToken,
        });
        return await service.fetchForPR(prData, prInfo, prUrl);
    } catch (e) {
        console.warn('Linked-issue lookup failed (non-fatal):', e?.message);
        return null;
    }
}

/** Stable identity for a finding — used to dedupe carried vs freshly derived. */
function findingKey(f) {
    const file = f?.file || f?.filePath || '';
    const head = (f?.title || f?.message || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    return `${file}|${f?.line ?? ''}|${head}`;
}

/** Notify the UI that this run is incremental, before any LLM work starts. */
function onIncrementalProgress(prUrl, plan) {
    try {
        chrome.runtime.sendMessage({
            type: 'PR_REVIEW_PROGRESS',
            data: {
                step: 'incremental_plan',
                phase: 'incremental',
                message: `Re-reviewing ${plan.changedFiles.length} changed file(s); ${plan.unchangedFiles.length} unchanged`,
                plan: {
                    mode: plan.mode,
                    changedFiles: plan.changedFiles,
                    unchangedFiles: plan.unchangedFiles.length,
                    previousHeadSha: plan.prevHeadSha
                },
                prUrl
            }
        }).catch(() => { });
    } catch { /* popup may be closed */ }
}

/**
 * Did a skip rule short-circuit this review, and if so what should we report?
 *
 * A gated run legitimately produces zero findings, so "no blocking findings"
 * cannot be read as "approved" — the pipeline never looked. Returns null for a
 * genuine review (gate.action === 'REVIEW', or the legacy engine path which has
 * no gate), letting the caller fall back to the finding-count verdict.
 *
 * `reviewEvent` is deliberately COMMENT for every non-approving outcome: the
 * popup forwards it straight to the host, and neither APPROVE nor
 * REQUEST_CHANGES is an honest thing to say about a PR we declined to read.
 *
 * @param {object} result - engine/adapter result (carries `_orchestrated`)
 * @returns {{verdict:string, reviewEvent:string, gateVerdict:string, reason:string}|null}
 */
export function describeGateOutcome(result) {
    const gate = result?._orchestrated?.meta?.gate ?? result?.gate ?? null;
    const action = String(gate?.action ?? '').toUpperCase();

    if (action === 'REVIEW' || !action) {
        // A PARTIAL review is a real review, so the finding count governs — except
        // that it may never APPROVE. It deliberately did not read every file, and
        // "approved" on an unread file is the same false assurance a silent SKIP
        // gave. Blocking findings still yield REQUEST_CHANGES: those were found in
        // code it actually read.
        if (gate?.partial?.skippedFileCount > 0) {
            return {
                partialOnly: true,
                verdict: 'NEEDS_DISCUSSION',
                reviewEvent: 'COMMENT',
                gateVerdict: 'PARTIAL',
                reason: gate.partial.reason,
            };
        }
        return null;
    }

    const reason = gate.reason || gate.classification || action.toLowerCase();

    if (action === 'SKIP') {
        return { verdict: 'SKIPPED', reviewEvent: 'COMMENT', gateVerdict: 'SKIP', reason };
    }
    if (action === 'DEFER') {
        return { verdict: 'DEFERRED', reviewEvent: 'COMMENT', gateVerdict: 'DEFER', reason };
    }
    if (action === 'AUTO_VERDICT') {
        // The only auto-verdict that may approve is one the rule explicitly
        // chose to approve (docs-only). Everything else is a discussion prompt.
        const approved = String(gate.verdict ?? '').toUpperCase() === 'APPROVE';
        return approved
            ? { verdict: 'APPROVED', reviewEvent: 'APPROVE', gateVerdict: 'APPROVE', reason }
            : { verdict: 'NEEDS_DISCUSSION', reviewEvent: 'COMMENT', gateVerdict: String(gate.verdict ?? 'NEEDS_DISCUSSION'), reason };
    }
    // Unknown action — be conservative rather than approving.
    return { verdict: 'NEEDS_DISCUSSION', reviewEvent: 'COMMENT', gateVerdict: action, reason };
}

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
        // Carried so the response verdict can tell "nothing was wrong" apart from
        // "nothing was reviewed" without reaching into `_orchestrated`.
        gate: report.meta?.gate ?? null,
    };
}

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function|{fn: Function, allowContentScript: boolean}>}
 */
export function createPrReviewHandlers(svc) {
    // Cache of the latest full multi-pass review result, keyed by PR URL, so a
    // background/auto review (triggered from the page) can be picked up by the popup
    // when it opens — instead of re-running. `reviewStatus` tracks running/done/error.
    const reviewResultCache = new Map();
    const reviewStatus = new Map();

    // Per-PR revision state for incremental re-review. Supplied by BackgroundService
    // when available; the local fallback keeps tests and older callers working.
    const incrementalReview = svc.incrementalReview || new IncrementalReviewService();

    // Canonical repo id from the PR URL — the SAME value the indexer (INDEX_REPOSITORY
    // → service.getRepoId) and the Repos panel use. Critical for GitLab: prData's
    // `branches.targetRepo` is a NUMERIC project id there, which never matches the
    // path-string id used for indexing/RAG/graph, so auto-index keyed under the wrong
    // id and everything looked "not indexed". Always prefer the URL-derived path.
    function canonicalRepoId(prUrl, prData) {
        try {
            const platform = detectPlatformOrGitHub(prUrl);
            const service = platform === 'gitlab' ? svc.gitlabService : svc.githubService;
            const id = service?.getRepoId?.(prUrl);
            if (id) return id;
        } catch { /* fall through */ }
        return prData?.branches?.targetRepo || `${prData?.author?.login || 'unknown'}/${prData?.title || 'unknown'}`;
    }

    /** Content-script-safe: report ONLY the two on-page-load flags (no secrets). */
    async function handleGetAutoReviewSetting(message, sendResponse) {
        try {
            const rs = (await svc.getStoredSettings())?.reviewSettings || {};
            sendResponse({
                success: true,
                enabled: rs.autoReviewOnLoad === true,        // auto-run a full review on open
                autoIndexOnOpen: rs.autoIndexOnOpen !== false  // index an un-indexed repo on open (default ON)
            });
        } catch (e) {
            sendResponse({ success: false, enabled: false, autoIndexOnOpen: false });
        }
    }

    /** Content-script-safe: index the PR's repo if it isn't indexed yet — a lightweight
     *  "index on open", separate from running a review. Gated on the autoIndexOnOpen
     *  setting; returns quickly if already indexed or disabled. */
    async function handleEnsureRepoIndexed(message, sendResponse) {
        const { prUrl } = message.data || {};
        if (!prUrl) { sendResponse({ success: false, error: 'PR URL is required' }); return; }
        try {
            const settings = await svc.getStoredSettings();
            const rs = settings?.reviewSettings || {};
            if (rs.autoIndexOnOpen === false) { sendResponse({ success: true, skipped: true }); return; }

            const repoId = canonicalRepoId(prUrl);
            let indexed = false;
            try { indexed = await svc.codeGraphPipeline.hasGraph(repoId); } catch { /* ignore */ }
            if (!indexed) { try { indexed = await svc.ragService?.vectorStore?.isIndexed?.(repoId); } catch { /* ignore */ } }
            if (indexed) { sendResponse({ success: true, alreadyIndexed: true, repoId }); return; }

            const repoUrl = repoUrlFromPrUrl(prUrl);
            const platform = detectPlatformOrGitHub(prUrl);
            const service = platform === 'gitlab' ? svc.gitlabService : svc.githubService;
            const files = await service.fetchRepositoryFiles(repoUrl);
            await svc.ragService.init();
            await svc.ragService.indexRepositoryIncremental(repoId, files);
            await svc.codeGraphPipeline.updateGraph(repoId, files);
            console.log(`📚 Indexed ${repoId} on open (${files.length} files)`);
            // The graph parses far fewer languages than the index accepts. Say so
            // when most of the repo is unparseable, or the cross-file findings
            // simply go missing with no explanation.
            const coverageWarning = graphCoverageWarning(assessGraphCoverage(files));
            if (coverageWarning) console.warn(`⚠️ ${coverageWarning}`);

            // Prewarm team conventions now. Unlike the index-time trigger in
            // indexingHandlers.js, `prUrl` here is a genuine PR/MR URL (this
            // handler is the PR-page-detection trigger the design spec named),
            // so `fetchReviewComments` can actually walk history and return
            // notes instead of the documented [] no-op for a bare repo URL.
            // Fire-and-forget and wrapped so a throw here cannot fail the
            // index-on-open response; the in-flight registry dedupes against
            // any other trigger for the same repo. Reuses `settings` already
            // fetched above — no second `getStoredSettings()` round-trip
            // (waitForEncryption + storage read + decrypting up to ten keys)
            // ahead of `sendResponse`.
            try {
                const miner = new ConventionMiner({ llmService: svc.llmService });
                miner.prewarm(
                    repoId,
                    () => svc.pullRequestService?.fetchReviewComments?.(prUrl) ?? Promise.resolve([]),
                    { settings },
                ).catch(() => { });
            } catch (e) {
                console.warn('Convention prewarm at page-detection time:', e?.message);
            }

            sendResponse({ success: true, indexed: true, repoId });
        } catch (e) {
            console.warn('Index-on-open failed:', e?.message);
            sendResponse({ success: false, error: svc.getErrorMessage(e) });
        }
    }

    /** Content-script-safe: run a full review, but ONLY if auto-review is enabled
     *  server-side (so a page script can't trigger reviews unless the user opted in). */
    async function handleAutoReviewPr(message, sendResponse, sender = null) {
        const { prUrl } = message.data || {};
        if (!prUrl) { sendResponse({ success: false, error: 'PR URL is required' }); return; }
        try {
            const settings = await svc.getStoredSettings();
            if (settings?.reviewSettings?.autoReviewOnLoad !== true) {
                sendResponse({ success: true, skipped: true });
                return;
            }
        } catch (e) {
            sendResponse({ success: false, error: svc.getErrorMessage(e) });
            return;
        }
        // Delegate to the full multi-pass pipeline (index-first + everything).
        // `sender` is forwarded so progress events reach the PR page's indicator —
        // this call arrives FROM the content script, and it is the one review that
        // blocks on indexing with nothing else on screen to show it is working.
        return handleMultiPassPRReview({
            data: {
                prUrl,
                options: { focusAreas: ['security', 'bugs', 'performance', 'style'], enableESLint: true, enableSemgrep: true, enableDependency: true }
            }
        }, sendResponse, sender);
    }

    /** Return the cached review result (if any) for a PR URL. */
    function handleGetPrReviewResult(message, sendResponse) {
        const { prUrl } = message.data || {};
        sendResponse({
            success: true,
            status: reviewStatus.get(prUrl) || 'none',
            data: reviewResultCache.get(prUrl) || null
        });
    }

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
            const repoId = canonicalRepoId(prUrl, prData);
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
                const standardsBlock = buildStandardsBlock(prLangs);
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
            const repoId = canonicalRepoId(prUrl, prData);

            const customConfig = await loadRepoConfig(svc, prUrl, settings);

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
    async function handleMultiPassPRReview(message, sendResponse, sender = null) {
        try {
            const { prUrl, options = {} } = message.data || message.payload || {};

            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }

            console.log('📋 Multi-pass PR review:', prUrl);
            reviewStatus.set(prUrl, 'running');
            await svc.updatePRServiceTokens();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            console.log(`📊 PR fetched: ${prData.files.length} files, +${prData.stats.additions} -${prData.stats.deletions}`);

            const multiPassStartedAt = Date.now();
            const settings = await svc.getStoredSettings();
            const reviewSettings = settings.reviewSettings || {};

            // How much of the fully-indexed repo may enter the prompt.
            // Resolved before any context producer runs so one switch moves
            // them all together — which is what makes an eval A/B meaningful.
            const contextBudget = resolveBudget({
                profile: options.contextProfile || reviewSettings.contextProfile,
                settings: reviewSettings.contextBudget,
                overrides: options.contextBudget,
            });

            // Enhance files with full content if enabled (not just patch lines)
            if (options.fetchFullFiles !== false) {
                try {
                    const headRef = prData.branches?.source;
                    prData.files = await svc.pullRequestService.enhanceFilesWithFullContent(
                        prUrl, prData.files,
                        { maxFiles: options.maxFullFiles || contextBudget.maxFullFiles, ref: headRef }
                    );
                    const enhanced = prData.files.filter(f => f.fullContent).length;
                    if (enhanced > 0) {
                        console.log(`📄 Enhanced ${enhanced} files with full content for deeper review`);
                    }
                } catch (enhanceErr) {
                    console.warn('Failed to enhance files with full content:', enhanceErr.message);
                }
            }

            const repoId = canonicalRepoId(prUrl, prData);

            // ── Review cache ─────────────────────────────────────────────────
            // A fresh hit (same head SHA) returns the previous review outright —
            // re-opening the panel on an unchanged PR should not cost the user
            // another run on their own key. A stale hit is kept as priming
            // context so consecutive reviews of a moving PR stay coherent
            // instead of re-rolling the dice each push.
            const reviewCache = new ReviewCacheService();
            let primingContext = '';
            if (reviewSettings.reviewCache !== false && options.forceFullReview !== true) {
                try {
                    const hit = await reviewCache.lookup(prUrl, prData.headSha);
                    if (hit.status === CACHE_STATUS.FRESH && options.bypassCache !== true) {
                        console.log(`💾 Cache hit (fresh, ${Math.round(hit.ageMs / 60000)}m old) — returning stored review`);
                        reviewStatus.set(prUrl, 'idle');
                        sendResponse({
                            success: true,
                            data: { ...hit.entry.payload, fromCache: true, cacheAgeMs: hit.ageMs }
                        });
                        return;
                    }
                    if (hit.status === CACHE_STATUS.STALE) {
                        primingContext = renderPrimingContext(hit.entry);
                        if (primingContext) {
                            console.log(`💾 Cache hit (stale) — priming with ${hit.entry.payload?.findings?.length || 0} prior finding(s)`);
                        }
                    }
                } catch (e) {
                    console.warn('Review cache lookup failed (non-fatal):', e?.message);
                }
            }

            // ── Feedback flywheel: read last round's verdicts BEFORE reviewing ──
            // Ticks the author left on our previous comments become labelled
            // examples. Runs before any LLM spend so a rule the team rejected
            // three times is already down-weighted for THIS review.
            if (reviewSettings.enableFeedbackFooter !== false) {
                try {
                    const collector = new FeedbackCollectorService({
                        pullRequestService: svc.pullRequestService,
                        adaptiveLearning: svc.adaptiveLearningService || null,
                    });
                    await collector.collect(prUrl, { repoId });
                } catch (e) {
                    console.warn('Feedback collection failed (non-fatal):', e?.message);
                }
            }

            // #16b — honour model pin from .repospector.yaml in multi-pass path
            const customConfig = await loadRepoConfig(svc, prUrl, settings);

            // Review-quality toggles (default ON), overridable via .repospector.yaml
            // `settings` block or the extension's reviewSettings. Everything below
            // runs on the user's own BYOK model — nothing leaves the machine.
            const rqCfg = { ...(reviewSettings || {}), ...(customConfig?.settings || {}) };
            const graphContextEnabled = rqCfg.graphContext !== false && options.graphContext !== false;
            // Verification ALWAYS runs — but "verification" now means the
            // deterministic evidence gates (cited line absent, construct only on
            // removed lines, documented handler, duplicates). Those are free and
            // are what actually removes false positives.
            const verificationEnabled = rqCfg.verifyFindings !== false && options.verifyFindings !== false;
            // The LLM refuter on top of them is OPT-IN. It kept 42 of 42 findings
            // that adjudication rejected on the measured set, so paying a
            // round-trip per batch for it by default was cost without effect.
            const llmRefutationEnabled = rqCfg.llmRefutation === true || options.llmRefutation === true;
            const autofixEnabled = rqCfg.autofix !== false && options.autofix !== false;
            const multiFinderEnabled = rqCfg.multiFinder !== false && options.multiFinder !== false;
            // Pull-based retrieval: the model asks the index for what it needs
            // mid-review. The default is decided per model rather than globally
            // — see `shouldExplore`. Resolved below, once the review model is
            // known; an explicit setting overrides in either direction.
            const explorationSetting = options.repoExploration ?? rqCfg.repoExploration;
            const explorationIterations = Number(
                rqCfg.explorationIterations || options.explorationIterations || 4,
            );
            // Mine team conventions from this repo's own past review comments.
            const conventionsEnabled = rqCfg.teamConventions !== false && options.teamConventions !== false;
            const verificationVotes = Number(rqCfg.verificationVotes || options.verificationVotes || 1);
            const finderRounds = Number(rqCfg.finderRounds || options.finderRounds || 2);
            // Which rule set the specialist finders run under. `recall` existed
            // but nothing ever selected it, so it was dead code; it is now
            // selectable and was A/B'd on the 5-PR public corpus:
            //
            //   default  35 generated → 32 kept → recall 8/26  (30.8%)
            //   recall   35 generated → 25 kept → recall 7/26  (26.9%)
            //
            // No measurable gain — the intervals overlap almost entirely — and
            // the recall lens lost MORE findings to the evidence gates, which is
            // what a looser rule set should do. `default` stays the default on
            // the evidence. Re-measure with a bigger corpus before flipping;
            // n=26 cannot separate these.
            const finderMode = rqCfg.finderMode || options.finderMode || 'default';
            // Self-reflection scoring. On by default because the score ORDERS
            // what gets posted, which is a strict improvement over the old
            // severity-only sort — every self-declared `high` used to be
            // interchangeable, so the inline cap truncated arbitrarily.
            // The DROP threshold is separately off by default (0): with the
            // pipeline currently under-producing findings, gating on score
            // would cut recall to buy precision we have not yet earned.
            const scoringEnabled = rqCfg.scoreFindings !== false && options.scoreFindings !== false;
            const minScore = Number(rqCfg.minScore ?? options.minScore ?? 0);
            // 'blocking' (default) | 'background' | false — see the indexing block below.
            // Without this, RAG + graph context are dark for any repo the user never
            // manually indexed.
            const autoIndexOwnRepo = rqCfg.autoIndexOwnRepo ?? options.autoIndexOwnRepo ?? 'blocking';

            // ── Incremental re-review: only re-read what moved since last time ──
            // Authors push fixes; re-running the whole pipeline each push is what
            // makes re-review expensive on a BYOK model. Findings on files whose
            // diff is byte-identical are carried forward instead of regenerated.
            const incrementalEnabled = rqCfg.incrementalReview !== false
                && options.incrementalReview !== false;
            let reviewPlan = null;
            if (incrementalEnabled) {
                try {
                    const prevState = await incrementalReview.getState(prUrl);
                    reviewPlan = incrementalReview.plan(prData, prevState, {
                        force: options.forceFullReview === true
                    });

                    if (reviewPlan.mode === REVIEW_MODE.UNCHANGED) {
                        const cached = reviewResultCache.get(prUrl);
                        if (cached) {
                            console.log(`⏭️  ${reviewPlan.reason} — returning the cached review (0 tokens spent)`);
                            reviewStatus.set(prUrl, 'done');
                            sendResponse({
                                success: true,
                                data: { ...cached, incremental: { ...reviewPlan, servedFromCache: true } }
                            });
                            return;
                        }
                        // No cached response to serve (worker restarted) — fall
                        // through and review normally rather than returning nothing.
                        reviewPlan = null;
                    } else if (reviewPlan.mode === REVIEW_MODE.INCREMENTAL) {
                        console.log(`♻️  Incremental re-review: ${reviewPlan.reason}`);
                        onIncrementalProgress(prUrl, reviewPlan);
                    }
                } catch (e) {
                    console.warn('Incremental planning failed; running a full review:', e?.message);
                    reviewPlan = null;
                }
            }

            // The engine only sees the files that need re-reading. Static analysis,
            // graph context and cross-repo impact still run over the FULL file set —
            // they are cheap/deterministic and their results depend on the whole PR.
            const allPrFiles = prData.files;
            const filesForEngine = reviewPlan?.mode === REVIEW_MODE.INCREMENTAL
                ? reviewPlan.filesToReview
                : allPrFiles;

            // Progress channel. Defined BEFORE indexing so the indexing phase can
            // report itself — a blocking index is the longest part of a first review
            // and a silent UI during it looks like a hang.
            //
            // TWO transports, because they reach different places: `runtime.sendMessage`
            // reaches extension pages (the popup), and `tabs.sendMessage` reaches the
            // content script on the PR page. A service worker's `runtime.sendMessage`
            // does NOT reach content scripts, so the on-page indicator saw nothing
            // without the second call.
            const progressTabId = sender?.tab?.id ?? null;
            const onProgress = (event) => {
                const payload = { type: 'PR_REVIEW_PROGRESS', data: event };
                try {
                    chrome.runtime.sendMessage(payload).catch(() => { });
                } catch (e) { /* popup may be closed */ }
                try {
                    if (progressTabId != null) {
                        chrome.tabs.sendMessage(progressTabId, payload).catch(() => { });
                    }
                } catch (e) { /* tab closed or navigated away */ }
            };

            // ── Index the PR's own repo BEFORE reviewing it ──────────────────────
            //
            // `autoIndexOwnRepo`:
            //   'blocking'  — index, THEN review. The review sees RAG + graph context.
            //   'background' — start indexing, review immediately without it.
            //   false        — do not index.
            //
            // 'blocking' is the default. 'background' was, and it made the promise the
            // setting appears to make false: the review proceeded against an empty
            // index, so the FIRST review of any repo had no retrieval, no code graph
            // and a cold convention miner — which is precisely the context class the
            // measured misses are dominated by. Fire-and-forget indexing helps the
            // *next* review, and the user is looking at this one.
            let indexStatus = 'unknown';
            let indexError = null;
            try {
                let indexed = false;
                try { indexed = await svc.codeGraphPipeline.hasGraph(repoId); } catch { /* ignore */ }
                if (!indexed) {
                    try { indexed = await svc.ragService?.vectorStore?.isIndexed?.(repoId); } catch { /* ignore */ }
                }
                if (indexed) {
                    indexStatus = 'already-indexed';
                } else if (autoIndexOwnRepo) {
                    const repoUrl = repoUrlFromPrUrl(prUrl);
                    const platform = detectPlatformOrGitHub(prUrl);
                    const service = platform === 'gitlab' ? svc.gitlabService : svc.githubService;
                    const doIndex = async (reportProgress) => {
                        const files = await service.fetchRepositoryFiles(
                            repoUrl,
                            reportProgress
                                ? (p) => onProgress({
                                    step: 'indexing',
                                    phase: 'indexing',
                                    message: p?.message || 'Indexing repository…',
                                    current: p?.current,
                                    total: p?.total,
                                })
                                : null,
                        );
                        if (reportProgress) {
                            onProgress({
                                step: 'indexing',
                                phase: 'indexing',
                                message: `Embedding ${files.length} file(s) — building review context…`,
                                total: files.length,
                            });
                        }
                        await svc.ragService.init();
                        await svc.ragService.indexRepositoryIncremental(repoId, files);
                        await svc.codeGraphPipeline.updateGraph(repoId, files);
                        // Surface this on the review path too: it predicts which
                        // findings the run cannot produce, which is worth knowing
                        // before the results come back rather than after.
                        const warning = graphCoverageWarning(assessGraphCoverage(files));
                        if (warning) {
                            console.warn(`⚠️ ${warning}`);
                            onProgress({ step: 'indexing', phase: 'indexing', message: warning });
                        }

                        // Prewarm team conventions here too — `prUrl` is a real
                        // PR/MR URL (this is the review's own auto-index, another
                        // PR-page-detection path per the design spec), so
                        // fetchReviewComments can walk history and return notes.
                        // Fire-and-forget and never allowed to fail the index;
                        // the in-flight registry dedupes across triggers. Reuses
                        // the enclosing `settings` (fetched once at the top of
                        // this handler) instead of a second getStoredSettings()
                        // round-trip.
                        try {
                            const convMiner = new ConventionMiner({ llmService: svc.llmService });
                            convMiner.prewarm(
                                repoId,
                                () => svc.pullRequestService?.fetchReviewComments?.(prUrl) ?? Promise.resolve([]),
                                { settings },
                            ).catch(() => { });
                        } catch (e) {
                            console.warn('Convention prewarm at review-path index time:', e?.message);
                        }

                        return files.length;
                    };

                    if (autoIndexOwnRepo === 'blocking') {
                        onProgress({
                            step: 'indexing',
                            phase: 'indexing',
                            message: 'Indexing the repository before reviewing…',
                        });
                        const fileCount = await doIndex(true);
                        indexStatus = 'indexed-now';
                        console.log(`📚 Auto-indexed ${repoId} (${fileCount} files, blocking) before review`);
                    } else {
                        // Explicit opt-out of index-first: this review runs on diff +
                        // full-file content only; the NEXT one gets full context.
                        doIndex(false)
                            .then(() => console.log(`📚 Auto-index of ${repoId} complete (context ready next review)`))
                            .catch(e => console.warn('Auto-index (background) failed:', e?.message));
                        indexStatus = 'indexing-started';
                    }
                } else {
                    indexStatus = 'not-indexed';
                }
            } catch (e) {
                // Fail OPEN: a repo we cannot index (permissions, rate limit, a tree
                // GitHub truncates) must still get a patch-level review. But say so —
                // having asked for index-first, silently reviewing without context is
                // the failure mode this change exists to remove.
                indexStatus = 'index-failed';
                indexError = e?.message || String(e);
                console.warn(`⚠️ Could not index ${repoId} before review — reviewing without repo context:`, indexError);
                onProgress({
                    step: 'indexing',
                    phase: 'indexing',
                    message: `Indexing failed (${indexError}); reviewing without repo context.`,
                    failed: true,
                });
            }

            // Small PRs used to short-circuit to the single-pass handler, which
            // returned a STRUCTURALLY DIFFERENT response: no perFileFindings, no
            // verifiedFindings, no verdict/reviewEvent/blockingCount, and none of
            // the multi-finder / verification / citation / fix passes. Since most
            // real PRs are small, the entire review-quality pipeline was dark for
            // the common case, and posting silently degraded to COMMENT because
            // reviewEvent was undefined.
            //
            // Every PR now runs the structured engine and the same post-processing,
            // so the response contract is identical regardless of size. The engine
            // costs one extra aggregation call on a tiny PR — a deliberate trade for
            // structured findings instead of regex-parsed prose. Users who want the
            // old cheap path can opt in explicitly with `singlePassForSmallPRs`.
            const FILE_THRESHOLD = options.multiPassThreshold ?? rqCfg.multiPassThreshold ?? 0;
            const singlePassOptIn = rqCfg.singlePassForSmallPRs === true
                || options.singlePassForSmallPRs === true;
            if (singlePassOptIn && prData.files.length <= (FILE_THRESHOLD || 3)) {
                console.log(`📋 PR has ${prData.files.length} files and singlePassForSmallPRs is on — using the cheap single-pass path (no verification/fix passes)`);
                return handleAnalyzePRWithStaticAnalysis(message, sendResponse);
            }

            // Gather context in parallel (graph context is best-effort/non-fatal)
            const graphService = new ReviewGraphContextService({
                codeGraphPipeline: svc.codeGraphPipeline,
                // Enables caller-source inlining; absent, the service emits summaries only.
                vectorStore: svc.ragService?.vectorStore,
            });
            const [ragContext, repoDocumentation, staticResult, graphContextObj, repoInstructions] = await Promise.all([
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
                }),
                graphContextEnabled
                    ? graphService.buildForReview(prData, repoId, { budget: contextBudget }).catch((e) => {
                        console.warn('Graph context (non-fatal):', e?.message);
                        return { available: false, byFile: {}, combined: '' };
                    })
                    : Promise.resolve({ available: false, byFile: {}, combined: '' }),
                loadRepoInstructions(svc, prUrl, settings)
            ]);

            if (graphContextObj?.available) {
                console.log(`🧠 Code-graph context injected for ${Object.keys(graphContextObj.byFile).length} files`);
            }

            // Real Python/Go AST lint (tree-sitter, runs in the offscreen doc). JS is
            // already covered by the acorn engine inside StaticAnalysisService. This
            // closes the measured py/go regex gap. Best-effort: merges into the static
            // findings, never fatal.
            try {
                const astLintFiles = (prData.files || [])
                    .filter(f => f.fullContent && OffscreenLintService.handles(f.filename))
                    .map(f => ({ path: f.filename, content: f.fullContent }));
                if (astLintFiles.length) {
                    const lintMap = await new OffscreenLintService().lintFiles(astLintFiles);
                    let added = 0;
                    for (const [filePath, findings] of lintMap) {
                        // Python/Go: the tree-sitter engine fully covers these languages
                        // and emits zero false positives, so REPLACE the noisy JS-shaped
                        // regex findings for that file. TypeScript: UNION — regex still
                        // contributes semantic families (access-control) the AST rules
                        // don't yet cover.
                        const isPyGo = /\.(py|pyw|go)$/i.test(filePath);
                        if (isPyGo) {
                            staticResult.findings = staticResult.findings.filter(
                                fnd => (fnd.filePath || fnd.file) !== filePath
                            );
                        }
                        for (const fnd of findings) { staticResult.findings.push(fnd); added++; }
                    }
                    if (added) {
                        staticResult.totalFindings = staticResult.findings.length;
                        console.log(`🌳 Tree-sitter AST lint: ${added} findings (py/go replace regex, ts union)`);
                    }
                }
            } catch (e) {
                console.warn('Python/Go AST lint (non-fatal):', e?.message);
            }

            console.log(`📊 Static analysis found ${staticResult.totalFindings} issues`);

            // Cache deterministic scores
            const reviewEffort = svc.pullRequestService.estimateReviewEffort(prData);
            if (!svc.prScoreCache.has(prUrl)) {
                svc.prScoreCache.set(prUrl, { reviewEffort, riskScore: staticResult.riskScore });
            }
            const cachedScores = svc.prScoreCache.get(prUrl);

            // #16b — apply model pin from .repospector.yaml
            const multiPassPinnedModel = customConfig?.settings?.model;
            const multiPassModel = multiPassPinnedModel || settings.model;
            if (multiPassPinnedModel && multiPassPinnedModel !== settings.model) {
                console.log(`🎯 Using model pinned by .repospector.yaml: ${multiPassPinnedModel}`);
            }

            // ── Team conventions mined from this repo's own review history ──
            // The largest class of review comments humans leave on these repos is
            // convention ("follow tenant_id naming", "use the shared http status
            // library"), which no generic rule set contains. Mined once per repo
            // and cached, so this costs one LLM call every couple of weeks — not
            // one per review.
            let conventionBlock = '';
            if (conventionsEnabled) {
                try {
                    const miner = new ConventionMiner({ llmService: svc.llmService });
                    const mineOpts = {
                        settings: { provider: settings.provider, model: multiPassModel, apiKey: settings.apiKey },
                    };

                    let mined = await miner.getCached(repoId);

                    // A mine started at index time or on page detection is
                    // probably already done or nearly so. Waiting briefly for it
                    // is what makes conventions available on a FIRST review —
                    // previously they arrived only in time for the second one,
                    // which is why the component was never measurable.
                    if (!mined && ConventionMiner.inFlight(repoId)) {
                        mined = await ConventionMiner.awaitWarm(repoId, CONVENTION_WARM_DEADLINE_MS);
                    }

                    // A sentinel result (insufficient history / no llm service /
                    // llm error) is NOT a usable answer — it was never persisted,
                    // so treat it the same as "nothing warm and nothing running"
                    // and start a mine for next time. A genuinely cached
                    // zero-rule result IS usable and must not trigger a re-mine
                    // (see ConventionMiner.isUsableResult).
                    if (!ConventionMiner.isUsableResult(mined)) {
                        // Nothing warm and nothing running: start it for next time,
                        // exactly as before. Not awaited — a cold first review
                        // should not pay a full round-trip plus a comment fetch.
                        miner.prewarm(
                            repoId,
                            () => svc.pullRequestService.fetchReviewComments?.(prUrl) ?? Promise.resolve([]),
                            mineOpts,
                        );
                    }

                    if (mined?.rules?.length) {
                        conventionBlock = ConventionMiner.renderBlock(mined);
                    }
                } catch (e) {
                    console.warn('Convention mining (non-fatal):', e?.message);
                }
            }

            // Resolve the model up front and fail loudly if it is not selected.
            // Every stage below (deep review, multi-finder, verification, fixes,
            // summary) must use THIS model and nothing else — there is no default.
            const resolvedModel = resolveModel(multiPassModel, {
                explicitProvider: settings.provider,
                context: 'PR review',
            });
            console.log(`🤖 Review model: ${resolvedModel.provider} / ${resolvedModel.modelId}`);

            // Exploration costs extra round trips on the user's own key. A
            // reasoning model means that cost has already been accepted, and
            // those are the models that use tools well rather than calling each
            // one once because it exists. The reason is logged either way, so a
            // user who expected exploration can see why it did not run.
            const exploration = shouldExplore({
                setting: explorationSetting,
                model: resolvedModel.modelIdentifier,
                provider: resolvedModel.provider,
                supportsTools: LLMService.supportsTools(resolvedModel.provider),
            });
            const repoExplorationEnabled = exploration.enabled;
            console.log(
                `🔭 Repo exploration ${exploration.enabled ? 'ON' : 'off'} — ${exploration.reason}`,
            );

            // Execute review — the orchestrated pipeline (skip rules + chunking +
            // assigned-hunks normalization) is the DEFAULT.
            //
            // It was opt-in while it was validated side-by-side, which meant the
            // common path skipped hunk normalization entirely and findings on
            // lines the PR never touched reached the summary. Now opt-OUT: set
            // `orchestratedReview: false` in reviewSettings, .repospector.yaml, or
            // per-call options to fall back to the legacy engine.
            const engine = new MultiPassReviewEngine({
                llmService: svc.llmService,
                ragService: svc.ragService
            });

            const useOrchestrator = options.orchestratedReview !== false
                && rqCfg.orchestratedReview !== false
                && reviewSettings.orchestratedReview !== false
                && settings.experimental?.orchestratedReview !== false;

            // On an incremental run the engine sees only the changed files, but it
            // still needs the whole-PR framing (title, description, commits, and
            // the list of files it is NOT re-reading) so cross-file reasoning and
            // the aggregation narrative stay coherent.
            const prDataForEngine = reviewPlan?.mode === REVIEW_MODE.INCREMENTAL
                ? { ...prData, files: filesForEngine }
                : prData;

            // ── Phase 2: file-level sight ────────────────────────────────────
            // The reviewer previously saw only `f.patch`. On the 50-MR benchmark
            // that scored 1.8% recall against human comments, because almost no
            // human comment is answerable from a hunk. Fetch the full post-change
            // file and its test file (bounded, soft-failing) so the model can
            // judge fit, coupling and coverage rather than just syntax.
            let fileContext = null;
            if (reviewSettings.fullFileContext !== false) {
                try {
                    const ctxSvc = new ReviewFileContextService({
                        pullRequestService: svc.pullRequestService
                    });
                    const built = await ctxSvc.build(prUrl, prDataForEngine, {
                        maxFiles: options.maxContextFiles || 12,
                        fetchTests: reviewSettings.fetchTestFiles !== false,
                        // Incremental runs only need context for what moved.
                        onlyFiles: reviewPlan?.mode === REVIEW_MODE.INCREMENTAL
                            ? filesForEngine.map(f => f.filename)
                            : null,
                    });
                    fileContext = built.byFile;
                    console.log(
                        `📄 File context: ${built.stats.fetched}/${built.stats.requested} files, ` +
                        `${built.stats.testsFound} test file(s) found, ${built.stats.testsMissing} missing, ` +
                        `${built.stats.failed} failed`
                    );
                } catch (e) {
                    // Soft — the prompt falls back to patch-only, exactly as before.
                    console.warn('Full-file context unavailable, reviewing patch-only:', e?.message);
                }
            }

            // ── Phase 2: intent ──────────────────────────────────────────────
            // What was this change SUPPOSED to do? Ticket + acceptance criteria,
            // CI state, author's description. Pure/synchronous — cannot fail.
            let intentBlock = '';
            try {
                // The ticket, when the PR names one. `options.issue` lets a
                // caller supply it directly (tests, or a future tracker
                // integration); otherwise resolve it from the host. Until this
                // lookup existed nothing ever populated `issue`, so the
                // acceptance-criteria branch inside buildIntentBlock had never
                // run in production.
                const issue = options.issue || await resolveLinkedIssue(svc, prUrl, prData);
                if (issue) {
                    console.log(`🎫 Linked issue ${issue.key}: ${issue.summary}`);
                }
                intentBlock = buildIntentBlock(prData, { issue });
                if (intentBlock) console.log('🎯 Intent context attached to review prompt');
            } catch (e) {
                console.warn('Intent context build failed (non-fatal):', e?.message);
            }

            // Carry the previous review forward (stale cache hit). Appended to the
            // intent block so it lands in the same "here is what you should know
            // before reading the diff" region of the prompt.
            if (primingContext) {
                intentBlock = intentBlock ? `${intentBlock}\n\n${primingContext}` : primingContext;
            }

            // ── Standards ────────────────────────────────────────────────────
            // The multi-pass path never used the standards block at all — only
            // the single-pass path did — so `src/standards/*.md` were dark for
            // the common case. Build it here, and overlay org-synced standards
            // when a source is configured so rules can change without an
            // extension release. Bundled text is always the floor.
            let standardsText = '';
            try {
                const prLangs = detectLanguages(prData.files);
                let block = buildStandardsBlock(prLangs);

                const stdSource = rqCfg.standardsSource || reviewSettings.standardsSource || null;
                if (stdSource) {
                    const sync = new StandardsSyncService();
                    const { standards: remote } = await sync.getStandards(stdSource, {
                        languages: [...prLangs],
                        headers: stdSource.type === 'gitlab' && settings.gitlabToken
                            ? { 'PRIVATE-TOKEN': settings.gitlabToken }
                            : undefined,
                    });
                    const merged = mergeStandards(block, remote, prLangs);
                    if (merged.remoteLangs.length) {
                        console.log(`📐 Org-synced standards applied for: ${merged.remoteLangs.join(', ')}`);
                    }
                    block = merged;
                }
                standardsText = block.text || '';
            } catch (e) {
                console.warn('Standards block build failed (non-fatal):', e?.message);
            }

            const reviewContext = {
                ragContext,
                repoDocumentation: repoDocumentation?.found ? repoDocumentation.content : null,
                staticFindings: staticResult.findings,
                graphContext: graphContextObj,
                isTestAutomationPR: svc.isTestAutomationPR(prData),
                conventionBlock,
                standardsText,
                repoInstructions,
                fileContext,
                intentBlock,
                contextBudget,
                incremental: reviewPlan?.mode === REVIEW_MODE.INCREMENTAL
                    ? {
                        previouslyReviewedSha: reviewPlan.prevHeadSha,
                        unchangedFiles: reviewPlan.unchangedFiles,
                        carriedFindingCount: reviewPlan.carriedFindings.length
                    }
                    : null
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
                        prDataForEngine, reviewContext, reviewSettings_, reviewOptions, onProgress
                    );
                    result = adaptOrchestratorReport(report);
                    result._orchestrated = report;
                    onProgress?.({ phase: 'complete', message: 'Review complete.', orchestrated: true });
                } else {
                    result = await engine.execute(
                        prDataForEngine, reviewContext, reviewSettings_, reviewOptions, onProgress
                    );
                }
            }

            // ── Post-processing pipeline: citation → verification → fix recs ──
            // Turns raw generated findings into a defended, cited, fixable set.
            // All stages are BYOK (user's own model) and individually toggleable.
            const postUsage = { input: 0, output: 0 };
            let citationStats = null;
            let verificationStats = null;
            let droppedFindings = [];
            let fixStats = null;
            let finderStats = null;
            let explorationStats = null;

            // 1) Canonical flat list (LLM per-file findings + deterministic static)
            //
            // The orchestrator has ALREADY lifted the static findings into its
            // report as the standards phase, and filtered them to the MR's
            // assigned hunks. Adding `staticResult.findings` again here would
            // list every static finding twice — once hunk-filtered, once not —
            // and double its weight in the blocking count. Take the report's
            // copy, which is the filtered one.
            let verifiedFindings = buildCanonicalFindings(
                result.perFileFindings || [],
                result._orchestrated ? [] : (staticResult.findings || [])
            );

            // 1b) Multi-finder diversity pass — independent specialist lenses surface
            //     what the baseline missed (recall), loop-until-dry. Verification (step
            //     3) then culls any false positives these extra finders introduce.
            if (multiFinderEnabled) {
                try {
                    // Retrieve prior-art candidates first: the reuse lens only runs
                    // when it has real evidence to cite, and is dropped otherwise
                    // rather than left to guess at duplication.
                    let reuseContext = '';
                    try {
                        const reuse = await new ReviewReuseContextService({ ragService: svc.ragService })
                            .buildForReview(prData, repoId);
                        reuseContext = reuse.context;
                        if (reuse.available) {
                            console.log(`♻️ Reuse candidates found for ${reuse.stats.symbolsWithHits}/${reuse.stats.symbolsProbed} new declarations`);
                        }
                    } catch (e) {
                        console.warn('Reuse context (non-fatal):', e?.message);
                    }

                    const finder = new MultiFinderService({ llmService: svc.llmService });
                    const fres = await finder.findAdditional(verifiedFindings, {
                        prData,
                        settings: reviewSettings_,
                        graphContext: graphContextObj?.combined || '',
                        reuseContext,
                        maxRounds: finderRounds,
                        promptMode: finderMode,
                        onProgress
                    });
                    if (fres.findings.length) verifiedFindings = [...verifiedFindings, ...fres.findings];
                    finderStats = fres.stats;
                    postUsage.input += fres.usage.input;
                    postUsage.output += fres.usage.output;
                    console.log(`🔎 Multi-finder (${finderMode}) added ${fres.stats.added} findings across ${fres.stats.rounds} round(s)`);
                } catch (e) {
                    console.warn('Multi-finder pass failed (using baseline findings):', e?.message);
                }
            }

            // 1b) Repo exploration — the only pass that can ASK the index a
            //     question mid-review. Runs before citations and verification so
            //     its findings face exactly the same scrutiny as every other
            //     finding; exploration buys recall, it does not buy trust.
            if (repoExplorationEnabled) {
                try {
                    const explorer = new RepoExplorerService({
                        llmService: svc.llmService,
                        ragService: svc.ragService,
                        codeGraphPipeline: svc.codeGraphPipeline,
                    });
                    const xres = await explorer.findWithExploration(verifiedFindings, {
                        prData,
                        settings: reviewSettings_,
                        repoId,
                        maxIterations: explorationIterations,
                        onProgress,
                    });
                    if (xres.findings.length) {
                        const fresh = freshFindings(verifiedFindings, xres.findings);
                        verifiedFindings = [...verifiedFindings, ...fresh];
                        explorationStats = { ...xres.stats, kept: fresh.length };
                        console.log(
                            `🔭 Repo exploration: ${xres.stats.toolCalls} tool call(s) over `
                            + `${xres.stats.iterations} iteration(s) → ${fresh.length} new finding(s)`,
                        );
                    } else {
                        explorationStats = xres.stats;
                    }
                    postUsage.input += xres.usage.input;
                    postUsage.output += xres.usage.output;
                } catch (e) {
                    console.warn('Repo exploration failed (continuing without it):', e?.message);
                }
            }

            // 2) Enforce citations — every finding ends up with a rule (inferred if absent)
            const cited = enforceCitations(verifiedFindings);
            verifiedFindings = cited.findings;
            citationStats = cited.stats;

            // 3) Adversarial verification — cut false positives (protects recall: fail-open)
            if (verificationEnabled && verifiedFindings.length > 0) {
                try {
                    const verifier = new FindingVerificationService({ llmService: svc.llmService });
                    const vres = await verifier.verify(verifiedFindings, {
                        prData,
                        settings: reviewSettings_,
                        votes: verificationVotes,
                        llmRefutation: llmRefutationEnabled,
                        onProgress
                    });
                    verifiedFindings = vres.findings;
                    droppedFindings = vres.dropped;
                    verificationStats = vres.stats;
                    postUsage.input += vres.usage.input;
                    postUsage.output += vres.usage.output;
                    console.log(
                        `✅ Verification (${llmRefutationEnabled ? 'gates + LLM refuter' : 'deterministic gates'}): ` +
                        `kept ${vres.stats.kept}, dropped ${vres.stats.dropped} likely FPs`
                    );
                } catch (e) {
                    console.warn('Verification pass failed (keeping all findings):', e?.message);
                }
            }

            // 3a-pre) Missing-test finder — deterministic, and covering a class
            //     RepoSpector structurally could not report before: the only test
            //     lens is gated on test files being IN the diff, so a PR that adds
            //     an exported function and no test had nothing looking. Emitted as
            //     `source: 'static'` because it is a fact about the diff text, not
            //     a model judgement. Added BEFORE verification so the evidence
            //     gates still see it like any other finding.
            try {
                const { findMissingTests } = await import('../../utils/missingTestFinder.js');
                const missing = findMissingTests(prData);
                if (missing.length) {
                    verifiedFindings = [...verifiedFindings, ...missing];
                    console.log(`🧪 Missing-test finder: ${missing.length} newly exported symbol(s) with no test in this PR`);
                }
            } catch (e) {
                console.warn('Missing-test finder skipped:', e?.message);
            }

            // 3a-bis) Sibling sweep — the instances of a flagged pattern that were
            //     never reviewed. Runs AFTER verification on purpose: sweeping from
            //     unverified findings would propagate a false positive into five
            //     more. Output is advisory and kept out of `verifiedFindings`, so
            //     it can never be posted as an inline comment or counted as a
            //     finding — measured precision does not permit multiplying claims.
            let siblingHits = [];
            try {
                const { sweepSiblings, diffsByFile } = await import('../../utils/siblingSweep.js');
                siblingHits = sweepSiblings(verifiedFindings, diffsByFile(prData));
                if (siblingHits.length) {
                    console.log(`🧹 Sibling sweep: ${siblingHits.length} unflagged candidate(s) of already-flagged patterns`);
                }
            } catch (e) {
                console.warn('Sibling sweep skipped:', e?.message);
            }

            // 3b) Self-reflection scoring — how much is each finding WORTH SAYING?
            //     Verification settled whether findings are real; this ranks the
            //     survivors so the inline cap keeps the valuable ones.
            let scoringStats = null;
            if (scoringEnabled && verifiedFindings.length > 0) {
                try {
                    const scorer = new SuggestionScorer({ llmService: svc.llmService });
                    const sres = await scorer.score(verifiedFindings, {
                        prData,
                        settings: reviewSettings_,
                        onProgress
                    });
                    verifiedFindings = sres.findings;
                    scoringStats = sres.stats;
                    postUsage.input += sres.usage.input;
                    postUsage.output += sres.usage.output;
                    console.log(
                        `🏅 Scored ${sres.stats.scored}/${sres.stats.input} findings ` +
                        `(min ${sres.stats.min}, mean ${sres.stats.mean}, max ${sres.stats.max})`
                    );
                } catch (e) {
                    console.warn('Scoring pass failed (findings keep their order):', e?.message);
                }
            }

            // 4) Fix recommendations — concrete suggested patch per finding (recommendation only)
            if (autofixEnabled && verifiedFindings.length > 0) {
                try {
                    const fixer = new FixRecommendationService({ llmService: svc.llmService });
                    const fres = await fixer.recommend(verifiedFindings, {
                        prData,
                        settings: reviewSettings_,
                        onProgress
                    });
                    verifiedFindings = fres.findings;
                    fixStats = fres.stats;
                    postUsage.input += fres.usage.input;
                    postUsage.output += fres.usage.output;
                    console.log(`🔧 Fix recommendations: ${fres.stats.produced}/${fres.stats.requested}`);
                } catch (e) {
                    console.warn('Fix recommendation pass failed:', e?.message);
                }
            }

            // 5) Merge findings carried over from files this run did not re-read.
            //    These were already verified and fix-annotated on a previous run,
            //    so they deliberately bypass steps 1b–4 — that saving IS the point
            //    of an incremental review. Dedupe defensively in case a carried
            //    finding overlaps one the static pass re-derived this run.
            let carriedCount = 0;
            if (reviewPlan?.mode === REVIEW_MODE.INCREMENTAL && reviewPlan.carriedFindings.length) {
                const seen = new Set(verifiedFindings.map(findingKey));
                const carried = reviewPlan.carriedFindings.filter(f => !seen.has(findingKey(f)));
                verifiedFindings = [...verifiedFindings, ...carried];
                carriedCount = carried.length;
                console.log(`♻️  Carried ${carriedCount} finding(s) forward from ${reviewPlan.unchangedFiles.length} unchanged file(s)`);

                // Say so in the narrative — a reader must be able to tell that
                // this run did not re-read every file, and against what revision.
                const note = IncrementalReviewService.describePlan({ ...reviewPlan, carriedFindings: carried });
                if (note && typeof result.analysis === 'string') {
                    result.analysis = `${note}\n\n${result.analysis}`;
                }
            }

            // Fold post-processing token usage into the result totals
            result.tokenUsage = {
                input: (result.tokenUsage?.input || 0) + postUsage.input,
                output: (result.tokenUsage?.output || 0) + postUsage.output
            };

            // ── Cross-repo impact (only when .repospector.yaml declares a workspace) ──
            // Checks each linked repo's graph for references to the symbols this PR
            // changed; auto-indexes a linked repo on demand when workspace.autoIndex.
            let crossRepoReport = null;
            try {
                const indexRepo = async (url) => {
                    const platform = detectPlatformOrGitHub(url);
                    const service = platform === 'gitlab' ? svc.gitlabService : svc.githubService;
                    const rid = service.getRepoId(url);
                    const files = await service.fetchRepositoryFiles(url);
                    await svc.codeGraphPipeline.updateGraph(rid, files);
                };
                const xrepo = new ReviewCrossRepoService({
                    indexRepo,
                    // Enables the discovery fallback when no workspace is declared.
                    vectorStore: svc.ragService?.vectorStore,
                });
                crossRepoReport = await xrepo.run({
                    prData, customConfig, currentRepoId: repoId, onProgress
                });
                if (crossRepoReport?.dependents?.length) {
                    const section = ReviewCrossRepoService.renderSection(crossRepoReport);
                    if (section && typeof result.analysis === 'string') {
                        result.analysis += `\n\n---\n\n${section}\n`;
                    }

                    // Promote impact into real findings rather than leaving it as
                    // narrative nobody scrolls to. Severity is gated on the MR
                    // brief: a REMOVED or re-signatured symbol that a linked repo
                    // still calls is blocking; a merely-referenced symbol is a
                    // suggestion. These are appended after verification on
                    // purpose — they are graph facts, not model guesses, so
                    // sending them to the refuter would only risk dropping them.
                    const brief = buildBrief(prData);
                    const xrepoFindings = ReviewCrossRepoService.toFindings(crossRepoReport, brief);
                    if (xrepoFindings.length) {
                        verifiedFindings = [...verifiedFindings, ...xrepoFindings];
                        const blocking = xrepoFindings.filter(f => f.severity === 'blocking').length;
                        console.log(`🔗 Cross-repo: ${xrepoFindings.length} finding(s) (${blocking} breaking)`);
                    }
                    console.log(`🔗 Cross-repo impact: ${crossRepoReport.dependents.length} linked repo(s) reference changed symbols`);
                }
            } catch (e) {
                console.warn('Cross-repo impact (non-fatal):', e?.message);
            }

            // Sibling sweep output — rendered as ONE advisory block, never as
            // inline comments. These are candidates the reviewer did not verify;
            // posting them at each site would present unverified guesses with the
            // same weight as adjudicated findings, which is the failure mode this
            // whole pipeline is built to avoid.
            if (siblingHits.length && typeof result.analysis === 'string') {
                try {
                    const { renderSweep } = await import('../../utils/siblingSweep.js');
                    const sweepSection = renderSweep(siblingHits);
                    if (sweepSection) result.analysis += `\n\n---\n\n${sweepSection}\n`;
                } catch (e) {
                    console.warn('Sibling sweep render skipped:', e?.message);
                }
            }

            // A review that ran WITHOUT repo context is a weaker review, and the reader
            // has to know which kind they are looking at — otherwise "it found nothing
            // about our conventions" is indistinguishable from "it had no idea what our
            // conventions are". Only stated when context was expected and missing.
            if (indexStatus === 'index-failed' || indexStatus === 'indexing-started') {
                const note = indexStatus === 'index-failed'
                    ? `> ⚠️ **Reviewed without repository context.** Indexing \`${repoId}\` failed`
                      + `${indexError ? ` (${indexError})` : ''}, so this review saw the diff and the`
                      + ` changed files but no retrieval, code graph or mined team conventions.`
                      + ` Re-run once indexing succeeds for a better-informed review.\n`
                    : `> ℹ️ **Reviewed without repository context.** Indexing of \`${repoId}\` was`
                      + ` started in the background rather than awaited, so this review saw the diff`
                      + ` and the changed files only. The next review of this repo will have full context.\n`;
                if (typeof result.analysis === 'string') {
                    result.analysis = `${note}\n${result.analysis}`;
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
                        // The SAME model the review used. This read `settings.model`,
                        // so a `.repospector.yaml` model pin applied to the review but
                        // not to the summary — two different models in one result.
                        model: multiPassModel,
                        apiKey: settings.apiKey,
                        stream: false,
                        context: 'PR summary'
                    }
                );
                aiSummary = summaryResponse.content || summaryResponse;
            } catch (e) {
                console.warn('Failed to generate PR summary:', e.message);
            }

            // Record review metrics from the VERIFIED set — the same list the
            // verdict and the posted review come from. Using the raw per-file
            // output would count false positives the pipeline had already cut,
            // and on an incremental run would miss the carried findings entirely.
            try {
                await svc.reviewMetricsService.recordReview({
                    repoId,
                    prUrl,
                    findings: verifiedFindings.filter(f => f.source !== 'static'),
                    staticFindings: staticResult.findings || [],
                    reviewType: reviewPlan?.mode === REVIEW_MODE.INCREMENTAL ? 'multi-pass-incremental' : 'multi-pass',
                    filesReviewed: filesForEngine.length
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

            // #22 — mechanical verdict from the VERIFIED finding set (post-FP-removal
            // and severity re-calibration), not the raw generated list.
            //
            // A short-circuit gate (draft, bot author, revert, merge conflict,
            // failing pipeline, oversized) produces ZERO findings by design. Deriving
            // the verdict from the finding count ALONE therefore reported
            // `APPROVED` / `APPROVE` for a PR nothing had looked at — and because
            // the popup forwards `reviewEvent` to the host verbatim, one click
            // posted a real approval on an unreviewed PR. Gate outcomes must win
            // over the finding count.
            const multiPassBlocking = countBlocking(verifiedFindings);
            const gateOutcome = describeGateOutcome(result);
            // A partial run still escalates on what it DID read; it just cannot approve.
            const blockingVerdict = multiPassBlocking > 0 ? 'CHANGES_REQUESTED' : null;
            const blockingEvent = multiPassBlocking > 0 ? 'REQUEST_CHANGES' : null;
            const multiPassVerdict = gateOutcome
                ? (gateOutcome.partialOnly ? (blockingVerdict ?? gateOutcome.verdict) : gateOutcome.verdict)
                : (blockingVerdict ?? 'APPROVED');
            const multiPassReviewEvent = gateOutcome
                ? (gateOutcome.partialOnly ? (blockingEvent ?? gateOutcome.reviewEvent) : gateOutcome.reviewEvent)
                : (blockingEvent ?? 'APPROVE');
            if (gateOutcome) {
                console.log(
                    `🚦 Gate outcome ${gateOutcome.gateVerdict} (${gateOutcome.reason}) — ` +
                    `reporting ${multiPassVerdict}/${multiPassReviewEvent} instead of an approval`
                );
            }

            const responseData = {
                    reviewedAt: Date.now(),
                    analysis: result.analysis,
                    reviewVerdict: multiPassVerdict,
                    reviewEvent: multiPassReviewEvent,
                    blockingCount: multiPassBlocking,
                    // Canonical verdict + the gate that produced it. `verdict` is what
                    // ReviewCacheService checks before storing, so a SKIP/DEFER run is
                    // recognisable as one instead of being cached as an approval.
                    verdict: gateOutcome?.gateVerdict ?? result.verdict ?? null,
                    gate: gateOutcome
                        ? { ...(result.gate ?? {}), outcome: gateOutcome }
                        : (result.gate ?? null),
                    // True only when the pipeline read NO code. A partial review read
                    // real files and may legitimately request changes on them, so it is
                    // not "skipped" — it is reported via `partial` instead.
                    reviewSkipped: !!gateOutcome
                        && !gateOutcome.partialOnly
                        && gateOutcome.gateVerdict !== 'APPROVE',
                    partial: result._orchestrated?.meta?.partial ?? null,
                    aiSummary,
                    isMultiPass: true,
                    perFileFindings: result.perFileFindings,
                    // Verified, cited, fix-annotated flat finding set (the authoritative
                    // list the verdict is computed from). UI can prefer this over the raw
                    // per-file findings.
                    verifiedFindings,
                    reviewQuality: {
                        citation: citationStats,
                        scoring: scoringStats,
                        minScore,
                        multiFinder: finderStats,
                        repoExploration: explorationStats,
                        verification: verificationStats,
                        droppedFalsePositives: droppedFindings,
                        fixes: fixStats,
                        graphContextUsed: !!graphContextObj?.available,
                        crossRepo: crossRepoReport,
                        indexStatus,
                        indexError,
                        // True when the review had the repo indexed before it ran, i.e.
                        // when RAG and code-graph context were actually available to it.
                        repoContextAvailable: indexStatus === 'already-indexed'
                            || indexStatus === 'indexed-now',
                    },
                    incremental: reviewPlan
                        ? {
                            mode: reviewPlan.mode,
                            reason: reviewPlan.reason,
                            previousHeadSha: reviewPlan.prevHeadSha,
                            headSha: reviewPlan.headSha,
                            filesReReviewed: reviewPlan.changedFiles.length,
                            filesSkipped: reviewPlan.unchangedFiles.length,
                            findingsCarried: carriedCount,
                            newCommits: reviewPlan.newCommits.length
                        }
                        : { mode: REVIEW_MODE.FULL, headSha: prData.headSha || null },
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
            };
            // A gated run reviewed nothing, so it must not seed any cache. Caching it
            // would make the in-memory UNCHANGED fast-path replay "skipped" forever,
            // and recording incremental state would mark every file as already
            // reviewed — so the review that SHOULD happen once the PR leaves draft
            // (or the pipeline goes green) would carry forward zero findings.
            const cacheableRun = !gateOutcome
                || gateOutcome.partialOnly            // real review of a subset — worth caching
                || gateOutcome.gateVerdict === 'APPROVE';
            if (cacheableRun) reviewResultCache.set(prUrl, responseData);
            reviewStatus.set(prUrl, 'done');

            // Persist the revision + verified findings so the NEXT push only
            // re-reads what actually moved. Never let this break a completed review.
            if (incrementalEnabled && cacheableRun) {
                try {
                    // Record against the full file set — the next plan diffs every
                    // file, including the ones this run carried rather than re-read.
                    await incrementalReview.record(
                        prUrl,
                        { ...prData, files: allPrFiles },
                        verifiedFindings
                    );
                } catch (e) {
                    console.warn('Could not persist incremental review state:', e?.message);
                }
            }

            // Cache the completed review against this head SHA. Serves the next
            // open of an unchanged PR outright, and primes the next run after a
            // push. `store` refuses SKIP/DEFER verdicts itself.
            if (reviewSettings.reviewCache !== false && cacheableRun) {
                try {
                    await reviewCache.store(prUrl, {
                        headSha: prData.headSha,
                        report: responseData,
                    });
                } catch (e) {
                    console.warn('Could not cache review result:', e?.message);
                }
            }

            sendResponse({ success: true, data: responseData });
        } catch (error) {
            try { reviewStatus.set((message.data || message.payload || {}).prUrl, 'error'); } catch { /* ignore */ }
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

            // Inline comments must be positioned on lines that exist in the diff,
            // so the formatter needs the PR's patches. We also need the PR's
            // existing comments to avoid reposting what we already said, so this
            // fetch is now unconditional rather than inline-only.
            let prDataForLines = null;
            try {
                prDataForLines = await svc.pullRequestService.fetchPullRequest(prUrl);
            } catch (e) {
                console.warn('Could not fetch PR for line validation / dedupe; posting without it:', e.message);
            }

            // ── Posting policy (Bastion <findings_policy>) ────────────────────
            // Only BLOCKING findings earn an inline comment. Everything else is
            // reported in the summary body. At the precision this pipeline
            // currently measures, posting every finding inline trains reviewers
            // to collapse the bot — which costs us the true positives too.
            const repoConfig = analysisResult?.repoConfig || null;
            const allFindings = analysisResult?.findings || [];

            const policy = partitionForPosting(allFindings, {
                severityThreshold:
                    options.severityThreshold
                    ?? repoConfig?.settings?.severityThreshold
                    ?? reviewSettings.severityThreshold
                    ?? null,
                minConfidence:
                    options.minConfidence
                    ?? repoConfig?.settings?.minConfidence
                    ?? null,
                // Value-score floor. 0 (the default) disables the gate; the
                // score still orders what goes inline.
                minScore:
                    options.minScore
                    ?? repoConfig?.settings?.minScore
                    ?? reviewSettings.minScore
                    ?? null,
                blockingOnlyInline: options.blockingOnlyInline !== false,
                maxInline: options.maxInlineComments || 15,
            });

            // ── Suppress anything we already commented on ────────────────────
            // Without this, every push reposts the full set — including findings
            // the author explicitly rejected last round.
            let inlineFindings = policy.inline;
            if (prDataForLines && options.dedupePriorComments !== false) {
                const prior = collectPriorBotComments(prDataForLines);
                if (prior.length) {
                    // Compare against the finding text only — the shared comment
                    // template and the feedback footer would otherwise make every
                    // pair of our own comments look similar.
                    const deduped = suppressAlreadyPosted(inlineFindings, prior.map(c => ({
                        ...c,
                        body: stripFeedbackFooter(c.body),
                    })));
                    inlineFindings = deduped.kept;
                    policy.stats.suppressedAsDuplicate = deduped.stats.suppressed;
                    if (deduped.stats.suppressed) {
                        console.log(`🔁 Suppressed ${deduped.stats.suppressed} finding(s) already commented on this PR`);
                    }
                }
            }

            // Generate one-click fix suggestions — only for what will actually be
            // posted inline. Previously this ran over every finding, paying for
            // patches on findings that were never going to be shown.
            if (options.generateFixes !== false) {
                const needFixes = inlineFindings.filter(f => !f.suggestedFix);
                if (needFixes.length) {
                    try {
                        await svc.pullRequestService.generateFixSuggestions(
                            needFixes, svc.llmService, settings
                        );
                    } catch (e) {
                        console.warn('Fix suggestion generation failed:', e.message);
                    }
                }
            }

            // Format the review summary, then append the demoted findings.
            let summaryBody = svc.pullRequestService.formatReviewSummary(
                analysisResult,
                aiSummary,
                { maxFindings: options.maxFindings || 10 }
            );

            const deferred = renderDeferredSections(policy.suggestions, policy.nitpicks);
            if (deferred) summaryBody += `\n${deferred}\n`;

            // Open questions, above the policy note and separate from the
            // defect lists — a question buried under "Nitpicks" gets skimmed.
            const escalationSection = renderEscalationSection(policy.escalations || []);
            if (escalationSection) summaryBody += `\n${escalationSection}\n`;

            // Two deterministic, token-free sections. Both are informational
            // rather than findings: neither claims anything is wrong, so neither
            // belongs in the findings pipeline or under the inline cap.
            // `prDataForLines` may be null when the PR fetch above failed; both
            // scans need the patches, so skip rather than emit empty sections.
            if (prDataForLines) {
                try {
                    const todoSection = renderTodoSection(scanAddedTodos(prDataForLines));
                    if (todoSection) summaryBody += `\n${todoSection}\n`;

                    const splitSection = renderSplitSuggestion(suggestSplit(prDataForLines));
                    if (splitSection) summaryBody += `\n${splitSection}\n`;
                } catch (e) {
                    console.warn('Informational sections (non-fatal):', e?.message);
                }
            }

            const policyNote = renderPolicyNote(policy.stats);
            if (policyNote) summaryBody += `\n${policyNote}\n`;

            const inlineComments = options.includeInlineComments !== false
                ? svc.pullRequestService.formatInlineComments(
                    inlineFindings,
                    {
                        maxInlineComments: options.maxInlineComments || 15,
                        prData: prDataForLines,
                        // The policy above is the authority on what gets posted;
                        // a second severity filter here would silently re-drop
                        // findings it already approved.
                        severities: null,
                        feedbackFooter: reviewSettings.enableFeedbackFooter !== false,
                    }
                )
                : [];

            // A review that was short-circuited by a skip rule read no code, so it
            // may only ever be posted as a COMMENT. This is a second, independent
            // check: the verdict computation upstream already refuses to emit
            // APPROVE for a gated run, and posting is irreversible enough to
            // deserve a guard that does not depend on that one being right.
            let postEvent = options.event || 'COMMENT';
            if (analysisResult?.reviewSkipped === true && postEvent !== 'COMMENT') {
                console.warn(
                    `⚠️ Refusing to post "${postEvent}" for a review that was skipped ` +
                    `(${analysisResult?.gate?.outcome?.reason || 'gated'}) — posting as COMMENT`
                );
                postEvent = 'COMMENT';
            }

            // Post the review
            const result = await svc.pullRequestService.postReview(prUrl, {
                summary: summaryBody,
                inlineComments,
                event: postEvent, // COMMENT, APPROVE, REQUEST_CHANGES
                diffRefs: prDataForLines?.diffRefs || null
            });

            console.log(
                `✅ Posted PR review: ${result.commentsPosted}/${result.commentsAttempted ?? inlineComments.length} inline comments, ` +
                `${policy.suggestions.length} suggestion(s) + ${policy.nitpicks.length} nitpick(s) in summary, ` +
                `summary: ${result.hasSummary}${result.degraded ? ' (degraded — batched post was rejected)' : ''}`
            );

            sendResponse({
                success: true,
                data: { ...result, policy: policy.stats }
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
     * Check whether a PR has moved since its last review — the cheap poll that
     * drives auto re-review on push. One API call, no LLM spend.
     */
    async function handleCheckPRForUpdates(message, sendResponse) {
        try {
            const { prUrl } = message.payload || message.data || {};
            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }
            await svc.updatePRServiceTokens();
            const [prData, prevState] = await Promise.all([
                svc.pullRequestService.fetchPullRequest(prUrl),
                incrementalReview.getState(prUrl)
            ]);
            const plan = incrementalReview.plan(prData, prevState);
            sendResponse({
                success: true,
                data: {
                    hasUpdates: plan.mode !== REVIEW_MODE.UNCHANGED,
                    reviewed: !!prevState,
                    mode: plan.mode,
                    reason: plan.reason,
                    headSha: plan.headSha,
                    previousHeadSha: plan.prevHeadSha,
                    changedFiles: plan.changedFiles
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Check PR for updates', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /** Drop a PR's incremental state so the next run re-reviews everything. */
    async function handleResetIncrementalReview(message, sendResponse) {
        try {
            const { prUrl } = message.payload || message.data || {};
            if (!prUrl) {
                sendResponse({ success: false, error: 'PR URL is required' });
                return;
            }
            await incrementalReview.clear(prUrl);
            reviewResultCache.delete(prUrl);
            sendResponse({ success: true, data: { cleared: true } });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle fetching full file content (not just patch)
     */
    async function handleFetchFullFile(message, sendResponse) {
        // `host` (or any URL on the instance) lets this resolve a self-hosted
        // GitLab. Absent, it falls back to gitlab.com, which is what it always
        // assumed unconditionally.
        const { repoId, filePath, platform, ref, host } = message.payload || message.data || {};

        try {
            const settings = await svc.getStoredSettings();
            let content;

            if (platform === 'github') {
                const token = settings.githubToken;
                const url = `${githubApiBase(host)}/repos/${repoId}/contents/${encodeURIComponent(filePath)}${ref ? `?ref=${ref}` : ''}`;
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
                const url = `${gitlabApiBase(host)}/projects/${projectPath}/repository/files/${encodedPath}/raw${ref ? `?ref=${ref}` : '?ref=main'}`;
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
        GET_PR_REVIEW_RESULT: (m, send) => handleGetPrReviewResult(m, send),
        // Auto-review is triggered from the content script (the on-page pill), so these
        // two must accept content-script messages. Both are server-gated on the
        // autoReviewOnLoad setting and never return secrets.
        GET_AUTO_REVIEW_SETTING: { fn: (m, send) => handleGetAutoReviewSetting(m, send), allowContentScript: true },
        AUTO_REVIEW_PR: { fn: (m, send, sender) => handleAutoReviewPr(m, send, sender), allowContentScript: true },
        ENSURE_REPO_INDEXED: { fn: (m, send) => handleEnsureRepoIndexed(m, send), allowContentScript: true },
        GET_PR_SUMMARY: (m, send) => handleGetPRSummary(m, send),
        SECURITY_REVIEW_PR: (m, send) => handleSecurityReviewPR(m, send),
        REVIEW_TEST_AUTOMATION: (m, send) => handleReviewTestAutomation(m, send),
        ANALYZE_PR_WITH_STATIC_ANALYSIS: (m, send) => handleAnalyzePRWithStaticAnalysis(m, send),
        MULTI_PASS_PR_REVIEW: (m, send, sender) => handleMultiPassPRReview(m, send, sender),
        RUN_STATIC_ANALYSIS: (m, send) => handleRunStaticAnalysis(m, send),
        POST_PR_REVIEW: (m, send) => handlePostPRReview(m, send),
        FETCH_FULL_FILE: (m, send) => handleFetchFullFile(m, send),
        EXPLAIN_HUNK: { fn: (m, send) => handleExplainHunk(m, send), allowContentScript: true },
        SUGGEST_FIX_HUNK: { fn: (m, send) => handleSuggestFixHunk(m, send), allowContentScript: true },
        POST_INLINE_COMMENT: { fn: (m, send) => handlePostInlineComment(m, send), allowContentScript: true },
        // Content-script-safe: the PR page polls this to detect a new push and
        // offer (or auto-run) an incremental re-review. Read-only, no secrets.
        CHECK_PR_FOR_UPDATES: { fn: (m, send) => handleCheckPRForUpdates(m, send), allowContentScript: true },
        RESET_INCREMENTAL_REVIEW: (m, send) => handleResetIncrementalReview(m, send),
    };
}

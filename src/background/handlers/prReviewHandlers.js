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
import { GraphImpactFindingsService } from '../../services/GraphImpactFindingsService.js';
import { ImpactAnalyzer } from '../../services/ImpactAnalyzer.js';
import { isDeterministicSource } from '../../utils/findingSources.js';
import { MultiFinderService } from '../../services/MultiFinderService.js';
import { ReviewReuseContextService } from '../../services/ReviewReuseContextService.js';
import { RepoExplorerService } from '../../services/RepoExplorerService.js';
import { freshFindings } from '../../utils/findingDedup.js';
import { assessGraphCoverage, graphCoverageWarning } from '../../utils/graphCoverage.js';
import { readIndexedSources } from '../../utils/indexedSource.js';
import { HypothesisValidationService } from '../../services/HypothesisValidationService.js';
import { runFindingPipeline } from '../../services/findingPipeline.js';
import { defendCandidates } from '../../services/candidateDefence.js';
import { rejectInvalidFixes } from '../../utils/fixValidation.js';
import {
    buildReviewSession,
    validateVerificationResult,
    applyVerification,
} from '../../services/reviewSession.js';
import { resolveInstructionScopes } from '../../utils/instructionScope.js';
import { admitDeterministic } from '../../utils/deterministicAdmission.js';
import {
    buildReviewFingerprint,
    withEvidenceDeps,
    hashParts,
    PIPELINE_VERSION,
} from '../../utils/reviewFingerprint.js';
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
import { SymbolExtractor } from '../../services/SymbolExtractor.js';
import { detectLanguageFromPath } from '../../utils/languageMap.js';
import { CallBudget, PRIORITY } from '../../utils/callBudget.js';
import { isAuthError, describeAuthError } from '../../utils/authErrors.js';
import { PriorFindingService } from '../../services/PriorFindingService.js';
import { resolveConfig, explainOverrides } from '../../utils/configPrecedence.js';
import { ExternalFindingsService } from '../../services/ExternalFindingsService.js';
import { applyFilterMode, describeFilterMode } from '../../utils/findingFilterMode.js';
import { decideFailure, describeFailLevel } from '../../utils/failLevel.js';
import {
    createCompleteness,
    mergeCompleteness,
    governVerdict,
    describeCompleteness,
} from '../../utils/reviewCompleteness.js';
import { describeTiering, settingsForStage } from '../../utils/modelTiers.js';
import { CONVENTION_WARM_DEADLINE_MS } from '../../utils/constants.js';
import {
    partitionForPosting,
    renderDeferredSections,
    renderEscalationSection,
    renderPolicyNote
} from '../../utils/reviewPostingPolicy.js';
import { collectPriorBotComments, suppressAlreadyPosted } from '../../utils/commentDedupe.js';
import { planSummary } from '../../utils/persistentSummary.js';
import {
    renderExternalSection,
    renderProvenanceNote,
    renderContextNote,
    renderGraphSection,
} from '../../utils/reviewProvenance.js';
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
import {
    filterGenuineProblems,
    buildPrecisionAnalysis,
    summarizeGenuineProblems,
} from '../../utils/genuineProblemGate.js';

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
 * The evidence provider handed to `HypothesisValidationService` (P1-6).
 *
 * Resolves each named evidence request against the local index and the code
 * graph — the same sources the explorer reads, but pulled deterministically by
 * the claim rather than chosen by a model. Returns `null` when it cannot get
 * the evidence, which the service records as MISSING; a provider that returned
 * an empty string on failure would make every unretrievable claim look
 * confirmed, which is the exact inversion this stage exists to prevent.
 */
function buildEvidenceProvider(svc, repoId, prData) {
    const vectorStore = svc.ragService?.vectorStore ?? null;
    const graph = svc.codeGraphPipeline?.graph ?? null;
    const patchByFile = new Map(
        (prData?.files || []).map(f => [f.filename, f.patch || ''])
    );

    return {
        async fetch(request) {
            const target = request?.target;
            const file = request?.finding?.file ?? request?.finding?.filePath ?? null;

            if (request?.kind === 'callers') {
                if (!graph) return null;
                const { listCallers } = await import('../../utils/graphQueries.js');
                const symbol = typeof target === 'string' ? target : null;
                if (!symbol) return null;
                const callers = listCallers(graph, symbol, { limit: 10 });
                if (!callers.length) return null;
                return {
                    text: callers.map(c => `${c.filePath}:${c.line ?? '?'}`).join('\n'),
                    location: { kind: 'graph', symbol },
                };
            }

            const path = typeof target === 'string' && target.includes('/') ? target : file;
            if (!path) return null;

            // The patch is free and already in hand; the indexed file costs a
            // store read. Prefer the file, fall back to the patch.
            const sources = vectorStore
                ? await readIndexedSources(vectorStore, repoId, [path])
                : new Map();
            const text = sources.get(path) || patchByFile.get(path) || '';
            if (!text) return null;
            return { text, location: { kind: 'file', path } };
        },
    };
}

/**
 * Resolve nested instruction files for the paths this change touches (P2-1).
 *
 * Soft in every direction: an unreachable file, an unparsed tree or a service
 * that is not wired all yield `null`, and the review proceeds on the root
 * instructions exactly as before.
 */
async function resolveScopedInstructions(svc, prUrl, settings, prData) {
    try {
        if (!svc.repoInstructionsService?.getScopedInstructions) return null;
        const ref = parseRepoRef(prUrl);
        if (!ref) return null;
        const token = ref.platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
        const apiBase = ref.platform === 'github' ? githubApiBase(prUrl) : gitlabApiBase(prUrl);
        const changed = (prData?.files || []).map(f => f.filename).filter(Boolean);

        const { files } = await svc.repoInstructionsService.getScopedInstructions({
            platform: ref.platform,
            owner: ref.owner,
            repo: ref.repo,
            projectPath: ref.projectPath,
            apiBase,
            token,
        }, changed);

        if (!files.length) return null;
        return resolveInstructionScopes(changed, files, { ref: 'default branch' });
    } catch (e) {
        console.warn('Scoped repo instructions (non-fatal):', e?.message);
        return null;
    }
}

/**
 * A stable identity for the scanner reports this review ingested (P1-4).
 *
 * Name and read-status per source, plus the tools and the finding count. A
 * re-run of the same job that produces a different number of annotations is a
 * different input and must invalidate; a source that failed to read is
 * distinguished from one that read and found nothing, because those are
 * different reviews.
 */
function scannerFingerprint(externalResult) {
    if (!externalResult) return null;
    const sources = (externalResult.sources || [])
        .map(s => `${s.name ?? 'unnamed'}:${s.ok ? 'ok' : 'failed'}`)
        .sort();
    return [
        ...sources,
        `tools=${(externalResult.stats?.tools || []).slice().sort().join('+')}`,
        `findings=${externalResult.findings?.length ?? 0}`,
    ];
}

/**
 * The completeness contract to travel with an exported session (P0-1 + P1-8).
 * A verifier that does not know half the diff went unread cannot judge what
 * "no other problems" would mean.
 */
function reviewCompletenessForSession(result, prData) {
    return mergeCompleteness(result?.completeness ?? null, prData?.completeness ?? null);
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
        description: f.description || '',
        impact: f.impact || null,
        confidence: f.confidence ?? null,
        score: f.score ?? null,
        scoreSource: f.scoreSource ?? null,
        tool: f.tool ?? null,
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
        // P0-1: the adapter used to drop every completeness signal the
        // orchestrator collected, so the handler's `result.stats.parseFailures`
        // read `undefined` on the DEFAULT path. Both shapes are carried now:
        // `stats` for the legacy readers, `completeness` for the contract.
        completeness: report.meta?.completeness ?? null,
        stats: { parseFailures: report.meta?.completeness?.parseFailures ?? 0 },
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
    // P1-8: exported verification sessions, keyed by PR URL. Bounded like the
    // result cache — a session is only useful while its head is current.
    const reviewSessions = new Map();

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
                options: { focusAreas: ['security', 'bugs', 'performance'], enableESLint: true, enableSemgrep: true, enableDependency: true }
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
                    focusAreas: options.focusAreas || ['security', 'bugs', 'performance'],
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
                    focusAreas: options.focusAreas || ['security', 'bugs', 'performance'],
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
            let aiSummaryError = null;
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
                aiSummaryError = e?.message || 'Unknown error';
                console.warn('Failed to generate PR summary:', aiSummaryError);
            }

            sendResponse({
                success: true,
                data: {
                    analysis: response.content || response,
                    aiSummary,
                    aiSummaryError,
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

            // #16b — honour model pin from .repospector.yaml in multi-pass path
            const customConfig = await loadRepoConfig(svc, prUrl, settings);

            // Review-quality toggles (default ON), overridable via .repospector.yaml
            // `settings` block or the extension's reviewSettings. Everything below
            // runs on the user's own BYOK model — nothing leaves the machine.
            // Layered resolution, not a spread: defaults → user Settings → org
            // policy → .repospector.yaml → this call. The chain, what an org may
            // pin, and why a repo config can never supply a credential are all
            // documented in utils/configPrecedence.js. `rqCfg` keeps its name and
            // shape so every existing `rqCfg.x !== false` test still reads the
            // same value it did before.
            const configResolution = resolveConfig({
                user: reviewSettings || {},
                org: settings.orgPolicy || null,
                repo: customConfig?.settings || {},
                call: options.settings || null,
            });
            const rqCfg = configResolution.config;
            if (configResolution.rejected.length) {
                for (const line of explainOverrides(configResolution)) console.warn(`⚙️  ${line}`);
            }

            // ── Review cache ─────────────────────────────────────────────────
            // A fresh hit (same head SHA) returns the previous review outright —
            // re-opening the panel on an unchanged PR should not cost the user
            // another run on their own key. A stale hit is kept as priming
            // context so consecutive reviews of a moving PR stay coherent
            // instead of re-rolling the dice each push.
            // Fetched before the cache decision rather than alongside the other
            // context below, because an edited `AGENTS.md`/`CLAUDE.md` changes
            // what a review says and must therefore invalidate a stored one.
            // `RepoInstructionsService` caches per repo with its own TTL, so the
            // later reuse of this value costs nothing.
            const repoInstructions = await loadRepoInstructions(svc, prUrl, settings);
            // P2-1: which instruction files govern which changed paths, with the
            // revision they were read at. A rule for `services/billing` must not
            // fire on `apps/web`, and a rule with no provenance is
            // indistinguishable from one this pull request supplied.
            const instructionScopes = await resolveScopedInstructions(svc, prUrl, settings, prData);
            if (instructionScopes?.warning) {
                console.warn(`📜 ${instructionScopes.warning}`);
            }
            const repoInstructionsFingerprint = repoInstructions
                ? hashParts([repoInstructions])
                : null;

            // ── Ingested scanner reports ─────────────────────────────────────
            //
            // Fetched BEFORE the cache decision, because a CodeQL run that
            // landed since the last review changes what this review says — and
            // P1-4 requires "relevant scanner inputs" to be part of what the
            // cache key proves. Leaving it downstream meant the field existed
            // and was wired to nothing: a new scanner report was served the
            // previous answer for the whole TTL. Costs one host call on a cache
            // hit, which is the price of being able to prove freshness at all.
            let externalResult = null;
            if (rqCfg.externalFindings !== false) {
                try {
                    externalResult = await new ExternalFindingsService({
                        pullRequestService: svc.pullRequestService,
                    }).collect({
                        prUrl,
                        prData,
                        config: customConfig,
                        reports: options.externalReports || [],
                        options: { checkAnnotations: rqCfg.checkAnnotations !== false },
                    });
                } catch (e) {
                    console.warn('External findings (non-fatal):', e?.message);
                }
            }

            const reviewCache = new ReviewCacheService();
            // P1-4: everything this review's output depends on, not just the head
            // SHA. A rebase onto a new base, a different model, a lowered
            // `minScore`, a new `failLevel`, an edited instruction file or a
            // rebuilt index all change the answer, and all of them used to be
            // invisible to the freshness check.
            const reviewFingerprint = buildReviewFingerprint({
                baseSha: prData.baseSha ?? prData.diffRefs?.base_sha ?? null,
                headSha: prData.headSha ?? null,
                model: customConfig?.settings?.model || settings.model || null,
                provider: settings.provider ?? null,
                config: rqCfg,
                instructions: repoInstructionsFingerprint,
                contextSnapshot: svc.codeGraphPipeline?.indexVersion
                    ?? svc.codeGraphPipeline?.snapshotId
                    ?? null,
                scanners: scannerFingerprint(externalResult),
            });

            let primingContext = '';
            if (reviewSettings.reviewCache !== false && options.forceFullReview !== true) {
                try {
                    const hit = await reviewCache.lookup(prUrl, prData.headSha, reviewFingerprint.hash);
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
                            console.log(
                                `💾 Cache hit (stale: ${hit.staleReason || 'unknown'}) — priming with `
                                + `${hit.entry.payload?.findings?.length || 0} prior finding(s)`
                            );
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
                    // `prState` lets the collector read a verdict from a thread
                    // whose box nobody ticked — resolved on a merged PR is a weak
                    // accept, still-open on a merged PR a weak reject. Most
                    // threads never get a tick, so this is where most of the
                    // ground truth actually comes from. Inferred rows are kept
                    // out of the precision figure; see
                    // FeedbackCollectorService._inferRow.
                    await collector.collect(prUrl, { repoId, prState: prData?.state || null });
                } catch (e) {
                    console.warn('Feedback collection failed (non-fatal):', e?.message);
                }
            }

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
            // Precision-first default: a finding must be valuable enough that a
            // competent reviewer would want to interrupt the author with it.
            // Repositories can raise this threshold, but cannot make an unscored
            // or low-value candidate become a reported defect.
            const scoringEnabled = rqCfg.scoreFindings !== false && options.scoreFindings !== false;
            const minScore = Math.max(7, Number(rqCfg.minScore ?? options.minScore ?? 7));
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
            const [ragContext, repoDocumentation, staticResult, graphContextObj] = await Promise.all([
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

            // ── External scanner findings ─────────────────────────────────────
            //
            // The team's OWN tools — CodeQL, golangci-lint, Trivy, Semgrep — read
            // from GitHub check annotations (no configuration needed) or from a
            // SARIF/rdjson artifact declared in `.repospector.yaml`. These are the
            // highest-credibility findings a review can carry: they cannot be
            // hallucinated, they carry a rule id and usually a documentation URL,
            // and the reader already trusts the tool that produced them.
            //
            // Merged into `staticResult.findings` so the review prompt SEES them
            // (the prompt asks the model to validate pre-detected findings and to
            // find what they missed), and appended to the final set after the
            // precision gate so a gate built for model output cannot suppress a
            // scanner's match. Same reasoning as the cross-repo findings below.
            // The scanner findings themselves are merged into `staticResult`
            // below, where the static analysis it joins actually exists. Only
            // the FETCH moved earlier — see the hoist above the cache lookup.
            if (externalResult?.findings?.length) {
                staticResult.findings.push(...externalResult.findings);
                staticResult.totalFindings = staticResult.findings.length;
                console.log(
                    `🛰️  External findings: ${externalResult.findings.length} from `
                    + `${externalResult.stats.tools.join(', ') || 'CI'} `
                    + `(${externalResult.stats.ok}/${externalResult.stats.sources} source(s) read)`
                );
            }
            for (const src of externalResult?.sources?.filter(x => !x.ok) ?? []) {
                console.warn(`🛰️  External source "${src.name}" not read: ${src.error}`);
            }

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
            let fileContextStats = null;
            if (reviewSettings.fullFileContext !== false) {
                try {
                    const ctxSvc = new ReviewFileContextService({
                        pullRequestService: svc.pullRequestService
                    });
                    const built = await ctxSvc.build(prUrl, prDataForEngine, {
                        // P1-5: one budget governs both full-file paths. This
                        // read `maxContextFiles` falling back to a hard-coded 12
                        // while the earlier fetch read `contextBudget.maxFullFiles`, so selecting
                        // the `legacy` context profile changed one of them and
                        // left the other at a hard-coded 12 — a profile that did
                        // not do what it said.
                        maxFiles: options.maxContextFiles
                            || options.maxFullFiles
                            || contextBudget.maxFullFiles,
                        fetchTests: reviewSettings.fetchTestFiles !== false,
                        // Incremental runs only need context for what moved.
                        onlyFiles: reviewPlan?.mode === REVIEW_MODE.INCREMENTAL
                            ? filesForEngine.map(f => f.filename)
                            : null,
                    });
                    fileContext = built.byFile;
                    fileContextStats = built.stats;
                    console.log(
                        `📄 File context: ${built.stats.fetched}/${built.stats.requested} files, ` +
                        `${built.stats.testsFound} test file(s) found, ${built.stats.testsMissing} absent, ` +
                        `${built.stats.testsUnknown} undetermined, ${built.stats.failed} failed` +
                        (built.stats.omitted.length ? `, ${built.stats.omitted.length} omission(s)` : '')
                    );
                } catch (e) {
                    // Soft — the prompt falls back to patch-only, exactly as before.
                    console.warn('Full-file context unavailable, reviewing patch-only:', e?.message);
                }
            }

            // ── Declaration ranges, for hunk expansion ───────────────────────
            //
            // `dynamicContext` grows each hunk out to the function or class that
            // encloses it, which needs to know where those start and end.
            // SymbolExtractor already computes exactly that (it is the node layer
            // of the knowledge graph) and is pure and synchronous, so it runs here
            // over the content we just fetched rather than requiring a graph
            // lookup — the graph may be stale or absent for a file this PR adds.
            //
            // Without ranges, expansion still works: it falls back to a fixed
            // asymmetric window. So this is best-effort by construction.
            let declarationsByFile = null;
            if (fileContext && reviewSettings.enableDynamicContext !== false) {
                declarationsByFile = new Map();
                try {
                    const extractor = new SymbolExtractor();
                    for (const [filename, ctx] of fileContext.entries()) {
                        if (!ctx?.fullContent) continue;
                        const language = detectLanguageFromPath(filename);
                        if (!language || language === 'unknown') continue;
                        const symbols = extractor.extractSymbols(ctx.fullContent, language, filename);
                        if (symbols?.length) declarationsByFile.set(filename, symbols);
                    }
                    console.log(
                        `🔎 Declaration ranges for ${declarationsByFile.size} file(s) — hunks will expand to their enclosing component`
                    );
                } catch (e) {
                    console.warn('Declaration extraction failed (non-fatal):', e?.message);
                    declarationsByFile = null;
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
                instructionScopes,
                fileContext,
                declarationsByFile,
                dynamicContext: { enabled: reviewSettings.enableDynamicContext !== false },
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
            // ── Model tiering ─────────────────────────────────────────────
            //
            // The heavy model reasons about code; the light one restates, ranks
            // and formats. With no light model configured every stage resolves to
            // the single model, so nothing changes for anyone who has not opted
            // in — a tiering scheme that silently downgraded the review pass would
            // trade accuracy for cost without asking. See utils/modelTiers.js.
            const lightModel = rqCfg.lightModel || null;
            const tieringNote = describeTiering({ model: multiPassModel, lightModel });
            if (tieringNote) console.log(`🪶 ${tieringNote}`);

            const reviewSettings_ = {
                provider: settings.provider,
                model: multiPassModel,
                apiKey: settings.apiKey,
                // Read by the stages listed as LIGHT in modelTiers.STAGE_TIERS.
                lightModel,
            };
            const reviewOptions = {
                focusAreas: options.focusAreas || ['security', 'bugs', 'performance'],
                maxConcurrent: options.maxConcurrent || 3,
                maxFilesToReview: options.maxFiles || 50
            };

            // Backend dispatch (Aegis) is currently disabled — the third-party
            // backend surface is hidden from the UI and the dispatch logic
            // removed. `AegisClient` import + `apps/api` remain in the
            // repository for future re-enable; see docs/adr/0001-backend-service.md.
            let result;

            // ── Cost ceiling for THIS review ─────────────────────────────────
            //
            // Armed on the shared LLMService and cleared in the `finally` below.
            // The service is a singleton on the background worker, so leaving a
            // budget attached would meter unrelated later work (chat, key
            // validation) against a review's exhausted allowance.
            //
            // Every pass from here on reaches `LLMService.callLLM`, which refuses
            // a call once the ceiling is hit. Refusal is not an outage: the stage
            // that asked catches it, is skipped, and the review completes with
            // what it has — reported in `reviewQuality.callBudget`.
            const callBudget = CallBudget.fromSettings(
                { maxAiCalls: reviewSettings.maxAiCalls },
                {
                    onRefusal: (r) => console.warn(
                        `💸 Call budget refused stage "${r.stage}" (${r.requested} call(s), `
                        + `${r.remaining} left of ${callBudget.limit})`
                    ),
                },
            );
            // Tolerant, but LOUD. An LLM client without the method (a test double,
            // or a future replacement) must not crash the review — but a silently
            // unmetered review is exactly the runaway this ceiling exists to
            // prevent, so a missing method is reported rather than shrugged off.
            if (typeof svc.llmService?.setCallBudget === 'function') {
                svc.llmService.setCallBudget(callBudget);
            } else {
                console.warn(
                    '⚠️  LLM client does not support setCallBudget — this review is NOT metered '
                    + 'and "Max AI calls per review" will not be enforced.'
                );
            }
            console.log(
                callBudget.unlimited
                    ? '💸 Call budget: unlimited (maxAiCalls = 0)'
                    : `💸 Call budget: ${callBudget.limit} LLM call(s) for this review`
            );

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
            let precisionStats = null;
            let precisionDropped = [];

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
                        // P1-5: which commit the index describes, and which one
                        // is under review. The explorer cannot fetch arbitrary
                        // revisions — there is no worktree here — but it can say
                        // when what it served is not the reviewed code, which is
                        // the failure that mattered.
                        indexedRevision: svc.codeGraphPipeline?.indexedCommit
                            ?? svc.codeGraphPipeline?.indexVersion
                            ?? null,
                        reviewedRevision: prData.headSha ?? null,
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

            // ── Candidate defence: citations → verification ──────────────────
            //
            // P2-2: the second runtime-neutral slice, in
            // services/candidateDefence.js. Both stages fail OPEN — a citation
            // enforcer that throws or a verifier that cannot reach its model
            // returns the candidates unchanged rather than an empty list,
            // because silence from a broken defence stage is indistinguishable
            // from a clean review.
            const defended = await defendCandidates(
                verifiedFindings,
                {
                    enforceCitations,
                    verifier: verificationEnabled
                        ? new FindingVerificationService({ llmService: svc.llmService })
                        : null,
                    onStageError: (stage, e) => console.warn(
                        `${stage} pass failed (candidates kept unchanged):`, e?.message,
                    ),
                },
                {
                    prData,
                    // P1-2: the post-change file bodies, so a quoted citation is
                    // checked against the FILE rather than only the diff.
                    fileContext,
                    settings: reviewSettings_,
                    options: {
                        votes: verificationVotes,
                        llmRefutation: llmRefutationEnabled,
                        onProgress,
                    },
                },
            );

            verifiedFindings = defended.findings;
            droppedFindings = defended.dropped;
            citationStats = defended.stats.citation;
            verificationStats = defended.stats.verification;
            postUsage.input += defended.usage.input;
            postUsage.output += defended.usage.output;

            if (verificationStats) {
                console.log(
                    `🕵️  Verification: kept ${verificationStats.kept}/${verificationStats.input}`,
                );
            }

            // 3a-pre) Missing-test finder — deterministic, and covering a class
            //     RepoSpector structurally could not report before: the only test
            //     lens is gated on test files being IN the diff, so a PR that adds
            //     an exported function and no test had nothing looking. Emitted as
            //     `source: 'static'` because it is a fact about the diff text, not
            //     a model judgement.
            //
            //     NOT appended to verifiedFindings here — see the missing-test
            //     re-add after the precision gate, below, for why.
            let missingTestFindingsPending = [];
            try {
                const { findMissingTests } = await import('../../utils/missingTestFinder.js');
                const missing = findMissingTests(prData);
                if (missing.length) {
                    missingTestFindingsPending = missing;
                    console.log(`🧪 Missing-test finder: ${missing.length} newly exported symbol(s) with no test in this PR`);
                }
            } catch (e) {
                console.warn('Missing-test finder skipped:', e?.message);
            }

            // 3a-graph) Graph-impact findings — the code graph as a reviewer.
            //     Deterministic (`source: 'graph'`): signature changes with un-updated
            //     callers outside the diff, high-risk symbols escalated to a human, and
            //     untested code in the blast radius. Emitted alongside the missing-test
            //     finder so the evidence gates and posting policy treat them identically.
            let graphFindingsStats = null;
            let graphFindingsPending = [];
            if (rqCfg.graphFindings !== false && graphContextObj?.available && svc.codeGraphPipeline?.graph) {
                try {
                    const pipeline = svc.codeGraphPipeline;
                    const impact = pipeline.impactAnalyzer || new ImpactAnalyzer(pipeline.graph);
                    // P1-3: the signature rule may only assert that a caller
                    // broke if it has READ that caller's call expression. The
                    // index is async and the service is not, so the caller files
                    // are collected first, fetched line-accurately, and handed
                    // back as a synchronous reader. When this comes back empty
                    // the rule degrades to a question instead of an assertion.
                    let callerSources = new Map();
                    try {
                        const probe = new GraphImpactFindingsService({
                            graph: pipeline.graph, impactAnalyzer: impact,
                        });
                        callerSources = await readIndexedSources(
                            svc.ragService?.vectorStore,
                            repoId,
                            probe.collectCallerFiles(prData),
                        );
                    } catch (e) {
                        console.warn('Caller source prefetch skipped (non-fatal):', e?.message);
                    }

                    const gsvc = new GraphImpactFindingsService({
                        graph: pipeline.graph,
                        impactAnalyzer: impact,
                        readSource: (path) => callerSources.get(path) ?? null,
                    });
                    const { findings: graphFindings, stats } = gsvc.build(prData);
                    const rules = {};
                    for (const f of graphFindings) rules[f.rule] = (rules[f.rule] || 0) + 1;
                    graphFindingsStats = { stats, rules };
                    if (graphFindings.length) {
                        // NOT appended to verifiedFindings here — see the graph
                        // re-add after the precision gate, below, for why.
                        graphFindingsPending = graphFindings;
                        console.log(`🕸️  Graph-impact findings: ${graphFindings.length} (${Object.entries(rules).map(([r, n]) => `${r.split('/')[1]}×${n}`).join(', ')})`);
                    }
                } catch (e) {
                    console.warn('Graph-impact findings skipped (non-fatal):', e?.message);
                }
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
                    // P1-6: a fix that cannot be applied is worse than none —
                    // the reviewer has to work out which of the two versions is
                    // real. Fixes whose `original` is not in the file, whose
                    // replacement does not parse, or which change nothing are
                    // removed. The FINDING survives: a defect does not stop
                    // being real because the proposed correction was wrong.
                    const sourceByFile = {};
                    for (const f of prData.files || []) {
                        if (f?.filename && typeof f.fullContent === 'string') {
                            sourceByFile[f.filename] = f.fullContent;
                        }
                    }
                    if (fileContext instanceof Map) {
                        for (const [name, ctx] of fileContext) {
                            if (typeof ctx?.fullContent === 'string') sourceByFile[name] = ctx.fullContent;
                        }
                    }
                    const checked = rejectInvalidFixes(fres.findings, { sourceByFile });

                    verifiedFindings = checked.findings;
                    fixStats = { ...fres.stats, validation: checked.stats };
                    postUsage.input += fres.usage.input;
                    postUsage.output += fres.usage.output;
                    console.log(
                        `🔧 Fix recommendations: ${fres.stats.produced}/${fres.stats.requested}`
                        + (checked.stats.rejected
                            ? ` (${checked.stats.rejected} could not be applied and were removed: `
                                + `${Object.keys(checked.stats.byReason).join(', ')})`
                            : ''),
                    );
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

            // ── Findings → what a reviewer will see ──────────────────────────
            //
            // P2-2: the precision gate, the three deterministic admissions,
            // hypothesis validation and diff scoping now live in
            // services/findingPipeline.js — the first runtime-neutral slice
            // extracted behind the completeness seam. Every gate, scanner and
            // validator arrives there as an injected adapter, so this handler
            // supplies the browser's and the API worker can supply its own
            // without either re-implementing the order or the stats.
            //
            // The extraction is incremental by design, and this slice was
            // chosen because it has no browser in it: findings in, findings
            // out, no chrome APIs, no fetch, no storage.
            const pipelineResult = await runFindingPipeline(
                verifiedFindings,
                {
                    precisionGate: (findings, opts) => filterGenuineProblems(findings, {
                        minConfidence: Math.max(
                            0.8,
                            Number(opts.minConfidence ?? options.minConfidence ?? 0.8),
                        ),
                        minScore: opts.minScore,
                    }),
                    admit: admitDeterministic,
                    scope: applyFilterMode,
                    validator: rqCfg.hypothesisValidation === false
                        ? null
                        : new HypothesisValidationService({
                            evidenceProvider: buildEvidenceProvider(svc, repoId, prData),
                            // No runner in an extension. A host that supplies one
                            // must declare it authorized AND isolated; anything
                            // less is treated as no runner at all.
                            runner: svc.executionRunner ?? null,
                        }),
                },
                {
                    external: externalResult?.findings ?? [],
                    graph: graphFindingsPending,
                    missingTests: missingTestFindingsPending,
                    files: prData.files || [],
                    revision: prData.headSha ?? null,
                    baseRevision: prData.baseSha ?? prData.diffRefs?.base_sha ?? null,
                    keyOf: findingKey,
                    config: {
                        minConfidence: rqCfg.minConfidence,
                        minScore,
                        filterMode: rqCfg.filterMode,
                        validationLimits: rqCfg.validationLimits || undefined,
                    },
                },
            );

            verifiedFindings = pipelineResult.findings;
            precisionDropped = pipelineResult.dropped;
            precisionStats = pipelineResult.stats.precision;
            const admissionStats = pipelineResult.stats.admission;
            const validationStats = pipelineResult.stats.validation;
            const filterModeStats = pipelineResult.stats.scope;
            const filterModeDropped = pipelineResult.dropped.filter(f => f.filteredBecause);

            if (precisionStats?.dropped) {
                console.log(
                    `🎯 Precision gate: kept ${precisionStats.kept}/${precisionStats.input}; `
                    + `suppressed ${precisionStats.dropped} unproven or low-value candidate(s)`,
                );
            }
            if (filterModeStats) console.log(`🎚️  ${describeFilterMode(filterModeStats)}`);
            if (validationStats) {
                console.log(
                    `🔬 Hypothesis validation: ${validationStats.confirmed} confirmed, `
                    + `${validationStats.refuted} refuted, ${validationStats.unresolved} unresolved`
                    + `${validationStats.executionAvailable ? '' : ' (no runner — source only)'}`,
                );
            }

            // ── Host-agent verification session ──────────────────────────────
            //
            // Built whenever the feature is on. In SHADOW mode (the default)
            // nothing about posting changes: the session is exported and any
            // verdicts that arrive are recorded for comparison, which is what
            // makes the ablation in P1-7 possible before this layer is trusted
            // with a posting decision.
            //
            // Candidates come from BEFORE the pipeline's suppression: the stage
            // exists to rescue a real bug the pipeline under-investigated, and
            // one already deleted for scoring 6 cannot be rescued (P1-8).
            let reviewSession = null;
            if (rqCfg.hostVerification === true || rqCfg.hostVerificationShadow !== false) {
                try {
                    reviewSession = buildReviewSession({
                        reviewId: `${prUrl}@${prData.headSha ?? 'unknown'}`,
                        repository: { url: prUrl, id: repoId },
                        baseSha: prData.baseSha ?? prData.diffRefs?.base_sha ?? null,
                        headSha: prData.headSha ?? null,
                        candidates: pipelineResult.preSuppressionCandidates,
                        withheld: pipelineResult.dropped,
                        completeness: reviewCompletenessForSession(result, prData),
                        pipelineVersion: PIPELINE_VERSION,
                    });
                    // Live mode is opt-in and separate from shadow: a session
                    // that only records must never be able to withhold a finding
                    // the pipeline would otherwise have posted.
                    reviewSession.shadow = rqCfg.hostVerification !== true;
                    // Retained so EXPORT_REVIEW_SESSION can hand it to a host
                    // agent and IMPORT_REVIEW_VERIFICATION can bind results back
                    // to it. Without this the session was built and discarded —
                    // infrastructure nobody could reach.
                    reviewSessions.set(prUrl, reviewSession);
                } catch (e) {
                    console.warn('Review session export skipped (non-fatal):', e?.message);
                }
            }

            // ── Prior review history ──────────────────────────────────────────
            //
            // What this team decided about these rules on this code before. The
            // ledger `FeedbackCollectorService` accumulates is the only ground
            // truth RepoSpector has that a hosted competitor cannot copy, and
            // until now it was consumed ONLY as a confidence number inside
            // `AdaptiveLearningService` — the reviewer never saw "you rejected
            // this rule twice on this file, most recently with 'intentional, see
            // ADR-14'", which is decisive information.
            //
            // ANNOTATES, never filters. Suppression on the strength of past
            // rejections belongs to the posting policy, where every other
            // suppression decision already lives and is already reported; a
            // service that silently dropped findings from this data would make
            // "the review stopped mentioning X" untraceable.
            let priorFindingStats = null;
            let relatedPRs = [];
            if (rqCfg.priorFindings !== false) {
                try {
                    const priorSvc = new PriorFindingService({
                        feedbackCollector: new FeedbackCollectorService({
                            pullRequestService: svc.pullRequestService,
                            adaptiveLearning: svc.adaptiveLearningService || null,
                        }),
                    });
                    const annotated = await priorSvc.annotate(verifiedFindings, { repoId });
                    verifiedFindings = annotated.findings;
                    priorFindingStats = annotated.stats;
                    relatedPRs = await priorSvc.relatedPRs(prData, { repoId });

                    if (annotated.stats.withHistory) {
                        console.log(
                            `🕰️  Prior history: ${annotated.stats.withHistory} finding(s) raised before `
                            + `(${annotated.stats.suppressRecommended} the team has settled, `
                            + `${annotated.stats.deprioritizeRecommended} leaning rejected)`
                        );
                    }
                } catch (e) {
                    console.warn('Prior review history (non-fatal):', e?.message);
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
            let aiSummaryError = null;
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
                        // The review's model, or the light model when one is
                        // configured: the summary restates findings that are
                        // already fixed, cited and verified, so it is composition
                        // rather than analysis. Still honours a
                        // `.repospector.yaml` model pin — reading
                        // `settings.model` here once meant the pin applied to the
                        // review but not the summary, i.e. two models in one
                        // result.
                        ...settingsForStage({
                            stage: 'summary',
                            provider: settings.provider,
                            model: multiPassModel,
                            apiKey: settings.apiKey,
                            lightModel,
                        }),
                        budgetStage: 'summary',
                        // NOT optional. The summary is the first thing the reader
                        // sees, and it is the LAST stage of the review — nothing
                        // essential runs after it, so there is no allowance left to
                        // protect. As an `optional` stage it was refused below the
                        // 15% floor, which on any PR large enough to spend ~85% of
                        // the ceiling meant the headline artifact silently went
                        // missing on exactly the reviews that needed it most.
                        budgetPriority: PRIORITY.IMPORTANT,
                        stream: false,
                        context: 'PR summary'
                    }
                );
                aiSummary = summaryResponse.content || summaryResponse;
            } catch (e) {
                // Reported, not swallowed. "No AI summary available" with no reason
                // is indistinguishable from "this PR did not warrant one", so the
                // cause travels to the UI with it.
                aiSummaryError = LLMService.isBudgetError(e)
                    ? 'The review used its whole LLM call budget before the summary. '
                      + 'Raise "Max AI calls per review" in Settings, or set it to 0 for no limit.'
                    : (e?.message || 'Unknown error');
                console.warn('Failed to generate PR summary:', aiSummaryError);
            }

            // Record review metrics from the VERIFIED set — the same list the
            // verdict and the posted review come from. Using the raw per-file
            // output would count false positives the pipeline had already cut,
            // and on an incremental run would miss the carried findings entirely.
            try {
                await svc.reviewMetricsService.recordReview({
                    repoId,
                    prUrl,
                    findings: verifiedFindings.filter(f => !isDeterministicSource(f.source)),
                    staticFindings: verifiedFindings.filter(f => isDeterministicSource(f.source)),
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
            //
            // The merge gate is now a declared threshold rather than
            // "any blocking finding". Default `high` reproduces the old
            // behaviour exactly; a team can set `failLevel: none` to comment
            // without ever blocking, and an org can pin it. See utils/failLevel.js.
            //
            // Verdict and event both come from ONE decision: they were two
            // independent expressions of the same rule before, which is one edit
            // away from contradicting each other.
            const failDecision = decideFailure(verifiedFindings, { failLevel: rqCfg.failLevel });
            const blockingVerdict = failDecision.verdict;
            const blockingEvent = failDecision.reviewEvent;
            console.log(`🚧 ${describeFailLevel(failDecision)}`);
            const rawVerdict = gateOutcome
                ? (gateOutcome.partialOnly ? (blockingVerdict ?? gateOutcome.verdict) : gateOutcome.verdict)
                : (blockingVerdict ?? 'APPROVED');
            const rawReviewEvent = gateOutcome
                ? (gateOutcome.partialOnly ? (blockingEvent ?? gateOutcome.reviewEvent) : gateOutcome.reviewEvent)
                : (blockingEvent ?? 'APPROVE');

            // P0-1: the completeness contract has the final say on approval.
            // Everything above decides what the FINDINGS justify; this decides
            // whether the run is entitled to make an affirmative claim at all.
            // Sources merged here: the engine/orchestrator contract, and the
            // host-diff fetch contract from PullRequestService (P0-4).
            const reviewCompleteness = mergeCompleteness(
                result?.completeness ?? null,
                result?.stats?.parseFailures
                    ? createCompleteness({ parseFailures: Number(result.stats.parseFailures) || 0 })
                    : null,
                prData?.completeness ?? null,
            );
            const governed = governVerdict(
                { verdict: rawVerdict, reviewEvent: rawReviewEvent },
                reviewCompleteness,
            );
            const multiPassVerdict = governed.verdict;
            const multiPassReviewEvent = governed.reviewEvent;
            if (governed.downgraded) {
                console.warn(
                    `🚧 Incomplete review — withdrawing approval: ${governed.reasons.join('; ')}`
                );
            }
            if (gateOutcome) {
                console.log(
                    `🚦 Gate outcome ${gateOutcome.gateVerdict} (${gateOutcome.reason}) — ` +
                    `reporting ${multiPassVerdict}/${multiPassReviewEvent} instead of an approval`
                );
            }

            const reviewWasSkipped = !!gateOutcome
                && !gateOutcome.partialOnly
                && gateOutcome.gateVerdict !== 'APPROVE';
            // A review unit whose per-file JSON never parsed (truncated output,
            // or the model answering in prose) contributed NOTHING. It is
            // functionally an unreviewed file, so it must get the same
            // treatment as one the orchestrator skipped: until now the count
            // was recorded in `reviewQuality` and read by nobody, and a
            // truncated file was reported inside a "Clean review".
            const parseFailures = reviewCompleteness.parseFailures;
            const reviewWasPartial = !!gateOutcome?.partialOnly || governed.reasons.length > 0;
            result.analysis = buildPrecisionAnalysis(verifiedFindings, {
                skipped: reviewWasSkipped,
                partial: reviewWasPartial,
                reason: gateOutcome?.reason,
            });
            // One rendering of every incompleteness reason — parse failures,
            // failed chunks, dropped hunks, host-diff gaps — instead of the
            // single hand-written parse-failure sentence this replaced.
            const completenessNote = describeCompleteness(reviewCompleteness);
            if (completenessNote) {
                result.analysis += `\n\n${completenessNote}`;
            }
            if (indexStatus === 'index-failed' || indexStatus === 'indexing-started') {
                const contextCaveat = indexStatus === 'index-failed'
                    ? `Reviewed without repository context because indexing failed${indexError ? `: ${indexError}` : ''}; this result is based on the diff and changed-file context only.`
                    : 'Reviewed without repository context because indexing is still in progress; this result is based on the diff and changed-file context only.';
                result.analysis += `\n\n> ⚠️ ${contextCaveat}`;
            }

            // Both kinds of DETERMINISTIC finding: our own analyzers and any
            // ingested scanner report. This drives the panel's static-analysis
            // view, and a CodeQL match belongs there — it is exactly the class of
            // finding that view exists to show. They stay distinguishable by
            // `source`/`attribution`, which is what the comment renderer uses.
            const reportableStaticFindings = verifiedFindings.filter(
                f => isDeterministicSource(f.source)
            );
            const precisionRiskScore = svc.staticAnalysisService?.confidenceScorer
                ?.calculateRiskScore?.(verifiedFindings)
                ?? (verifiedFindings.length === 0
                    ? { score: 100, level: 'low', description: 'No genuine problems found' }
                    : { score: null, level: 'unknown', description: 'Evidence-backed problems found' });
            const precisionRecommendation = verifiedFindings.length === 0
                ? {
                    action: 'approve',
                    verdict: 'Clean',
                    reason: 'No genuine problems were found in the changed code',
                    priority: [],
                }
                : {
                    action: multiPassBlocking > 0 ? 'block' : 'review',
                    verdict: multiPassBlocking > 0 ? 'Changes Requested' : 'Problems Found',
                    reason: `${verifiedFindings.length} evidence-backed problem(s) found`,
                    priority: ['Address the reported defects'],
                };

            const responseData = {
                    reviewedAt: Date.now(),
                    // The head this result describes. Read by the posting
                    // handler's head re-check (P1-8): without it, a comment can
                    // be placed against a revision the author has already moved
                    // past, on lines that no longer exist.
                    headSha: prData.headSha ?? null,
                    baseSha: prData.baseSha ?? prData.diffRefs?.base_sha ?? null,
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
                    reviewSkipped: reviewWasSkipped,
                    // Also true when a review unit's output never parsed — that
                    // file was not reviewed, whatever the orchestrator reported.
                    partial: result._orchestrated?.meta?.partial ?? (governed.reasons.length > 0 ? true : null),
                    // The full contract, so the UI and the cache can say WHAT
                    // was not read rather than only that something wasn't.
                    completeness: reviewCompleteness,
                    incomplete: governed.reasons.length > 0,
                    incompleteReasons: governed.reasons,
                    aiSummary,
                    aiSummaryError,
                    isMultiPass: true,
                    perFileFindings: result.perFileFindings,
                    // Verified, cited, fix-annotated flat finding set (the authoritative
                    // list the verdict is computed from). UI can prefer this over the raw
                    // per-file findings.
                    verifiedFindings,
                    reviewQuality: {
                        // Files whose per-file JSON never parsed (truncated
                        // output, or the model returning prose) — surfaced so
                        // the UI can say "N files could not be read" instead
                        // of silently reporting them as clean.
                        parseFailures,
                        citation: citationStats,
                        scoring: scoringStats,
                        minScore,
                        precision: precisionStats,
                        precisionDropped,
                        multiFinder: finderStats,
                        repoExploration: explorationStats,
                        verification: verificationStats,
                        droppedFalsePositives: droppedFindings,
                        fixes: fixStats,
                        graphContextUsed: !!graphContextObj?.available,
                        graphFindings: graphFindingsStats,
                        // What each non-model source was admitted as, and how
                        // many entries lacked the provenance to be reportable.
                        // A review reporting 6 problems of which 5 are
                        // "reported by a scanner" is a different claim from one
                        // where 5 were checked against source (P1-3).
                        deterministicAdmission: admissionStats,
                        // What was sought, what came back, and what it settled.
                        hypothesisValidation: validationStats,
                        // The exported session, so the popup can hand it to a
                        // host agent and import structured results back.
                        hostVerification: reviewSession
                            ? {
                                reviewId: reviewSession.reviewId,
                                shadow: reviewSession.shadow,
                                candidates: reviewSession.candidates.length,
                                withheld: reviewSession.withheld.length,
                            }
                            : null,
                        // P1-5: what was actually READ. Files and hunks the
                        // budget declined, test lookups that failed rather than
                        // came back empty, and the measured prompt reserve —
                        // so "the review said nothing about X" is traceable to a
                        // decision instead of read as a clean bill of health.
                        contextCoverage: {
                            fileContext: fileContextStats,
                            engine: result?.contextCoverage ?? null,
                        },
                        // What the ceiling actually cost this review: total spend,
                        // per-stage breakdown, and any stage it refused. Without the
                        // refusal list a budget-shortened review is indistinguishable
                        // from a review that simply found less.
                        callBudget: callBudget.snapshot(),
                        callBudgetNote: callBudget.describeIfConstrained() || null,
                        // Where each review setting came from, and anything a layer
                        // asked for and did not get — so a toggle that had no effect
                        // is explainable instead of mysterious.
                        configProvenance: configResolution.provenance,
                        configEnforced: configResolution.enforced,
                        configRejected: configResolution.rejected,
                        // Which of the team's own scanners were read, and what
                        // each contributed — including the ones that failed. A
                        // review that silently lost its CodeQL findings looks
                        // identical to one where CodeQL found nothing, and the
                        // second is a much stronger claim.
                        externalFindings: externalResult
                            ? { sources: externalResult.sources, stats: externalResult.stats }
                            : null,
                        // The diff scope that was applied, and everything it
                        // dropped or moved.
                        filterMode: filterModeStats,
                        filterModeNote: filterModeStats ? describeFilterMode(filterModeStats) : null,
                        filterModeDropped,
                        // Why this review blocks, or why it does not.
                        failLevel: {
                            level: failDecision.level,
                            blocks: failDecision.blocks,
                            reason: failDecision.reason,
                            blockingCount: failDecision.blockingFindings.length,
                        },
                        failLevelNote: describeFailLevel(failDecision),
                        modelTiering: tieringNote || null,
                        // What this team decided about these rules before, and the
                        // PRs that touched the same files. Drives the "Prior review
                        // history" section of the summary.
                        priorFindings: priorFindingStats,
                        relatedPRs,
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
                        findings: reportableStaticFindings,
                        summary: summarizeGenuineProblems(reportableStaticFindings),
                        unfilteredCount: staticResult.findings.length,
                        riskScore: precisionRiskScore,
                        recommendation: precisionRecommendation
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
            //
            // A non-empty aiSummaryError also blocks the store: a provider credit
            // or credential failure is transient and user-fixable (e.g. topping up
            // an account or switching providers), so caching it would make the
            // error sticky for the full TTL with no UI escape hatch other than
            // bypassing the cache entirely.
            if (reviewSettings.reviewCache !== false && cacheableRun && !aiSummaryError) {
                try {
                    await reviewCache.store(prUrl, {
                        headSha: prData.headSha,
                        fingerprint: reviewFingerprint.hash,
                        fingerprintParts: reviewFingerprint.parts,
                        report: {
                            ...responseData,
                            // Which files each finding's evidence rests on, so a
                            // later run can invalidate a carried finding whose
                            // callee changed even though its own file did not.
                            verifiedFindings: withEvidenceDeps(responseData.verifiedFindings),
                        },
                    });
                } catch (e) {
                    console.warn('Could not cache review result:', e?.message);
                }
            }

            sendResponse({ success: true, data: responseData });
        } catch (error) {
            try { reviewStatus.set((message.data || message.payload || {}).prUrl, 'error'); } catch { /* ignore */ }
            svc.errorHandler.logError('Multi-pass PR Review', error);

            // A credential failure gets its own kind and its own wording. The
            // raw provider text is a JSON blob naming an HTTP status; what the
            // user needs is which credential failed and where to fix it. It is
            // also broadcast on the progress channel so a popup that is open and
            // watching a running review is told immediately, rather than only
            // learning about it if it happens to still be listening for the
            // final response.
            if (isAuthError(error)) {
                let provider = null;
                try {
                    provider = (await svc.getStoredSettings())?.provider || null;
                } catch { /* provider is a nicety in the message, not required */ }
                const friendly = describeAuthError(error, { provider });
                try {
                    chrome.runtime.sendMessage({
                        type: 'PR_REVIEW_PROGRESS',
                        data: {
                            phase: 'error',
                            errorKind: 'auth',
                            provider,
                            message: friendly,
                        },
                    }).catch(() => { /* no listener — the response below still carries it */ });
                } catch { /* ignore */ }

                sendResponse({
                    success: false,
                    error: friendly,
                    errorKind: 'auth',
                    provider,
                    // The provider's own words, for a user who needs the detail.
                    providerError: svc.getErrorMessage(error),
                });
                return;
            }

            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        } finally {
            // The LLMService is a singleton on the worker: a budget left attached
            // would meter the user's next chat message against this review's
            // exhausted allowance. Cleared on every exit path, including a throw
            // before the review ever started.
            try { svc.llmService?.clearCallBudget?.(); } catch { /* ignore */ }
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

            // ── Head re-check ─────────────────────────────────────────────────
            //
            // P1-8: between reviewing and posting, the author can push. A
            // comment placed against the reviewed head then lands on lines that
            // have moved, and a verification verdict earned at that head no
            // longer describes the code being merged. `prDataForLines` was just
            // fetched, so the current head is already in hand and the check is
            // free.
            //
            // Refuse rather than post-anyway: a stale inline comment on the
            // wrong line is worse than no comment, and it is the author who can
            // cheaply re-run.
            const reviewedHead = analysisResult?.headSha
                ?? analysisResult?.reviewSnapshot?.headSha
                ?? null;
            const currentHead = prDataForLines?.headSha ?? null;
            if (reviewedHead && currentHead && reviewedHead !== currentHead) {
                const session = reviewSessions.get(prUrl);
                if (session) reviewSessions.delete(prUrl);
                sendResponse({
                    success: false,
                    error: `The pull request moved since this review: it was reviewed at `
                        + `${String(reviewedHead).slice(0, 8)} and its head is now `
                        + `${String(currentHead).slice(0, 8)}. Nothing was posted — inline `
                        + `comments would land on lines that have changed`
                        + `${session ? ', and any host-agent verdicts no longer describe this code' : ''}`
                        + `. Re-run the review to post against the current head.`,
                    data: { headChanged: true, reviewedHead, currentHead },
                });
                return;
            }

            // ── Posting policy ────────────────────────────────────────────────
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
                    // Posting is a separate action from the review, so it does not
                    // inherit the review's budget — but it spends the same key on
                    // the same model, so it answers to the same setting. Without
                    // this, one click could issue up to 25 unmetered calls.
                    const postBudget = CallBudget.fromSettings(
                        { maxAiCalls: reviewSettings.maxAiCalls },
                        {
                            onRefusal: (r) => console.warn(
                                `💸 Call budget refused stage "${r.stage}" while posting `
                                + `(${r.remaining} left of ${postBudget.limit})`
                            ),
                        },
                    );
                    svc.llmService?.setCallBudget?.(postBudget);
                    try {
                        await svc.pullRequestService.generateFixSuggestions(
                            needFixes, svc.llmService, settings
                        );
                    } catch (e) {
                        console.warn('Fix suggestion generation failed:', e.message);
                    } finally {
                        svc.llmService?.clearCallBudget?.();
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

            const policyNote = renderPolicyNote(policy.stats);
            if (policyNote) summaryBody += `\n${policyNote}\n`;

            // ── Provenance ────────────────────────────────────────────────────
            //
            // Which of the team's own scanners were read, what scope the review
            // held itself to, why it did or did not request changes, and anything
            // the call ceiling cut. All of this previously existed only in
            // `console.log` and `reviewQuality` — i.e. nowhere the person the
            // review is written for would ever see it. A guarantee nobody can see
            // is not a guarantee. See utils/reviewProvenance.js.
            const rq = analysisResult?.reviewQuality || null;

            const externalSection = renderExternalSection(rq?.externalFindings);
            if (externalSection) summaryBody += `\n${externalSection}\n`;

            const graphSection = renderGraphSection(rq?.graphFindings);
            if (graphSection) summaryBody += `\n${graphSection}\n`;

            // What this team decided about these rules before. Rendered from the
            // findings themselves (each carries `priorFindings` after the review
            // annotated it), so it stays in step with whatever survived the
            // posting policy rather than describing findings that were cut.
            const historySection = PriorFindingService.renderSection({
                annotatedFindings: [...inlineFindings, ...(policy.suggestions || []), ...(policy.nitpicks || [])],
                relatedPRs: analysisResult?.reviewQuality?.relatedPRs || [],
            });
            if (historySection) summaryBody += `\n${historySection}\n`;

            const contextNote = renderContextNote(rq);
            if (contextNote) summaryBody += `\n${contextNote}\n`;

            const provenanceNote = renderProvenanceNote(rq);
            if (provenanceNote) summaryBody += `\n${provenanceNote}\n`;

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

            // ── One summary per PR, updated in place ──────────────────────
            //
            // Every run used to post a NEW summary. A PR reviewed five times
            // accumulated five, four of them describing code that no longer
            // exists, and the reader had to work out which was current from
            // timestamps. The previous body is folded into a collapsed history
            // block rather than discarded, because replies are attached to it.
            //
            // The inline comments still go through `postReview` — those are
            // per-line and already deduped by `commentDedupe`.
            let summaryUpdated = null;
            let summaryForPost = summaryBody;

            if (reviewSettings.persistentSummary !== false) {
                try {
                    const existing = await svc.pullRequestService.fetchIssueComments(prUrl);
                    const plan = planSummary({
                        summary: summaryBody,
                        comments: existing,
                        // `prDataForLines` is this handler's freshly fetched PR
                        // (see above); the review's own `prData` is not in scope
                        // here. `analysisResult` carries the SHA the review
                        // actually ran against, which is the more accurate label
                        // when the head has moved since — so prefer it.
                        headSha: analysisResult?.prData?.headSha
                            || analysisResult?.incremental?.headSha
                            || prDataForLines?.headSha
                            || null,
                    });

                    if (plan.action === 'update') {
                        await svc.pullRequestService.updateIssueComment(prUrl, plan.commentId, plan.body);
                        summaryUpdated = plan.commentId;
                        // Already posted, so the review call below must not repeat
                        // it — but it still carries the inline comments and the
                        // APPROVE/REQUEST_CHANGES event, which live on the review
                        // object rather than on a comment.
                        summaryForPost = '';
                        console.log(`♻️  Updated the existing review summary (comment ${plan.commentId})`);
                    } else {
                        summaryForPost = plan.body;
                    }
                } catch (e) {
                    // Soft: fall back to posting a fresh summary. A failed edit
                    // must never cost the review.
                    console.warn('Persistent summary unavailable, posting a new comment:', e?.message);
                    summaryForPost = summaryBody;
                }
            }

            // Post the review
            const result = await svc.pullRequestService.postReview(prUrl, {
                summary: summaryForPost,
                inlineComments,
                event: postEvent, // COMMENT, APPROVE, REQUEST_CHANGES
                diffRefs: prDataForLines?.diffRefs || null
            });
            if (summaryUpdated) result.summaryUpdatedInPlace = summaryUpdated;

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

    /**
     * Hand the review session to a host agent. P1-8.
     *
     * An explicit export, not an automatic bridge: a browser extension cannot
     * assume access to a local MCP host, so the user carries the payload across
     * and the trust boundary stays visible. The returned object is exactly what
     * `get_review_candidates` serves, so the host sees one schema either way.
     */
    async function handleExportReviewSession(message, sendResponse) {
        const { prUrl, includeWithheld = false } = message.data || message.payload || {};
        const session = reviewSessions.get(prUrl);
        if (!session) {
            sendResponse({
                success: false,
                error: 'No review session for that PR. Run a review first; sessions are built '
                    + 'during the review and are tied to the head that was reviewed.',
            });
            return;
        }
        sendResponse({
            success: true,
            data: {
                ...session,
                withheld: includeWithheld ? session.withheld : undefined,
            },
        });
    }

    /**
     * Take a host agent's verdicts back. P1-8.
     *
     * Every result is validated against the session it claims to answer —
     * unknown ids, edited candidates, stale snapshots and uncited confirmations
     * are refused with reasons rather than absorbed. Accepting a result
     * establishes provenance, not correctness, and in shadow mode it changes
     * nothing about what would be posted.
     */
    async function handleImportReviewVerification(message, sendResponse) {
        const { prUrl, results = [] } = message.data || message.payload || {};
        const session = reviewSessions.get(prUrl);
        if (!session) {
            sendResponse({ success: false, error: 'No review session for that PR.' });
            return;
        }

        // Citations are checked against the files this review actually covered,
        // so a verdict cannot cite a file nobody read.
        const cached = reviewResultCache.get(prUrl);
        const fileLines = new Map();
        for (const f of cached?.data?.prFiles || []) {
            if (f?.filename && Number.isFinite(Number(f.lines))) {
                fileLines.set(f.filename, Number(f.lines));
            }
        }

        const accepted = [];
        const rejected = [];
        for (const submitted of results) {
            const check = validateVerificationResult(
                session,
                { ...submitted, reviewId: session.reviewId },
                { fileLines: fileLines.size ? fileLines : null },
            );
            if (check.ok) accepted.push(check.result);
            else rejected.push({ candidateId: submitted?.candidateId ?? null, errors: check.errors });
        }

        const applied = applyVerification(session, accepted, { shadow: session.shadow !== false });

        // Live mode withholds refuted candidates from the cached result the UI
        // reads. Shadow mode records and changes nothing, which is what makes
        // the before/after ablation possible before this layer is trusted.
        if (!applied.shadow && cached?.data?.verifiedFindings) {
            const refuted = new Set(applied.refuted.map(c => c.candidateId));
            cached.data.verifiedFindings = cached.data.verifiedFindings.filter(
                (f, i) => !refuted.has(String(f.id ?? `c${i}`)),
            );
            reviewResultCache.set(prUrl, cached);
        }

        sendResponse({
            success: true,
            data: {
                accepted: accepted.map(r => r.candidateId),
                rejected,
                shadow: applied.shadow,
                stats: applied.stats,
                blocksApproval: applied.blocksApproval,
                note: 'Recorded. Nothing was posted and no pull request was approved. Schema, '
                    + 'session binding and citations were checked mechanically, which establishes '
                    + 'provenance and not correctness.',
            },
        });
    }

    return {
        ANALYZE_PULL_REQUEST: (m, send) => handleAnalyzePullRequest(m, send),
        // P1-8: the explicit export/import handoff. Neither posts a comment nor
        // approves anything; publication stays a separate, authorized act.
        EXPORT_REVIEW_SESSION: (m, send) => handleExportReviewSession(m, send),
        IMPORT_REVIEW_VERIFICATION: (m, send) => handleImportReviewVerification(m, send),
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

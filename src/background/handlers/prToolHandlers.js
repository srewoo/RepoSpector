/**
 * prToolHandlers — the four PR-scoped tools that are not the review itself.
 *
 *   GENERATE_PR_LABELS    /labels     deterministic labels from the diff
 *   GENERATE_DOCSTRINGS   /add-docs   docstrings for declarations this PR touched
 *   ASK_LINE_QUESTION     /ask-line   a question about one line
 *   PRIOR_REVIEW_HISTORY  /history    what this team decided about this code before
 *
 * They live together because they share one piece of setup: three of them need
 * file CONTENT rather than just the diff (a docstring needs the whole
 * declaration, a line question needs the lines around the line, expansion needs
 * the file to expand into), and that fetch is bounded and identical each time.
 * `withFileContext` is that shared preamble.
 *
 * Each handler is thin on purpose — the logic is in the services, which are pure
 * enough to unit-test without Chrome.
 */

import { LabelGeneratorService } from '../../services/LabelGeneratorService.js';
import { DocstringService } from '../../services/DocstringService.js';
import { LineQuestionService } from '../../services/LineQuestionService.js';
import { PriorFindingService } from '../../services/PriorFindingService.js';
import { ReviewFileContextService } from '../../services/ReviewFileContextService.js';
import { SymbolExtractor } from '../../services/SymbolExtractor.js';
import { FeedbackCollectorService } from '../../services/FeedbackCollectorService.js';
import { CallBudget } from '../../utils/callBudget.js';
import { detectLanguageFromPath } from '../../utils/languageMap.js';
import { parseRepoRef, githubApiBase, gitlabApiBase } from '../../utils/gitHosts.js';

/**
 * Files a tool will read content for. Much tighter than the review's 12: these
 * commands answer a focused question, and a docstring pass over 12 files
 * produces a diff nobody will read.
 */
const TOOL_MAX_FILES = 6;

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>}
 */
export function createPrToolHandlers(svc) {
    /**
     * Fetch the PR, its file content, and declaration ranges.
     *
     * Declarations come from `SymbolExtractor` over the fetched content — the
     * same source the review uses, for the same reason: the knowledge graph may
     * be stale or missing entirely for a file this PR adds.
     */
    async function withFileContext(prUrl, { onlyFiles = null, maxFiles = TOOL_MAX_FILES } = {}) {
        await svc.updatePRServiceTokens();
        const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
        const settings = await svc.getStoredSettings();

        let fileContext = new Map();
        try {
            const ctxSvc = new ReviewFileContextService({ pullRequestService: svc.pullRequestService });
            const built = await ctxSvc.build(prUrl, prData, {
                maxFiles,
                // These tools never need the test file; only the review's
                // coverage check does, and fetching it doubles the calls.
                fetchTests: false,
                onlyFiles,
            });
            fileContext = built.byFile;
        } catch (e) {
            console.warn('[PR tools] File content unavailable:', e?.message);
        }

        const declarationsByFile = new Map();
        try {
            const extractor = new SymbolExtractor();
            for (const [filename, ctx] of fileContext.entries()) {
                if (!ctx?.fullContent) continue;
                const language = detectLanguageFromPath(filename);
                if (!language || language === 'unknown') continue;
                const symbols = extractor.extractSymbols(ctx.fullContent, language, filename);
                if (symbols?.length) declarationsByFile.set(filename, symbols);
            }
        } catch (e) {
            console.warn('[PR tools] Declaration extraction failed:', e?.message);
        }

        return { prData, settings, fileContext, declarationsByFile };
    }

    /** The repo's `labels:` block from `.repospector.yaml`, or []. Never throws. */
    async function loadCustomLabels(prUrl) {
        try {
            const settings = await svc.getStoredSettings();
            const ref = parseRepoRef(prUrl);
            if (!ref || !svc.customRulesService?.fetchConfig) return [];
            const token = ref.platform === 'gitlab' ? settings.gitlabToken : settings.githubToken;
            const apiBase = ref.platform === 'github' ? githubApiBase(prUrl) : gitlabApiBase(prUrl);
            const cfg = await svc.customRulesService.fetchConfig(
                ref.platform, ref.owner, ref.repo, token,
                { projectPath: ref.projectPath, apiBase },
            );
            return Array.isArray(cfg?.labels) ? cfg.labels : [];
        } catch (e) {
            console.warn('[PR tools] Custom labels unavailable:', e?.message);
            return [];
        }
    }

    /**
     * Arm the same per-review call ceiling for a tool invocation.
     *
     * A tool is not a review, but it spends the user's key on the same model, so
     * it answers to the same setting. The budget is per-invocation and cleared
     * after, exactly as in the review path.
     */
    function armBudget(settings) {
        const budget = CallBudget.fromSettings({
            maxAiCalls: settings?.reviewSettings?.maxAiCalls ?? settings?.maxAiCalls,
        });
        if (typeof svc.llmService?.setCallBudget === 'function') {
            svc.llmService.setCallBudget(budget);
        }
        return budget;
    }

    function disarmBudget() {
        try { svc.llmService?.clearCallBudget?.(); } catch { /* ignore */ }
    }

    // ── /labels ──────────────────────────────────────────────────────────────
    async function handleGeneratePRLabels(message, sendResponse) {
        try {
            const { prUrl, apply = false } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            await svc.updatePRServiceTokens();
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);

            // Custom labels come from the repo's own config, so a team's
            // vocabulary lives next to their code rather than in one person's
            // extension settings. Resolved through `parseRepoRef` for the same
            // reason the review path does: an inline URL regex never matched
            // self-hosted GitLab and mis-parsed subgroups.
            const customLabels = await loadCustomLabels(prUrl);

            const generator = new LabelGeneratorService({ pullRequestService: svc.pullRequestService });
            const result = generator.generate({
                prData,
                findings: message.data?.findings || [],
                customLabels,
            });

            let applied = null;
            if (apply) {
                // A write. Reported separately from the suggestion so a failed
                // apply (no token, no permission) still returns the labels.
                try {
                    applied = await generator.apply(prUrl, result.labels, {
                        existing: (prData.labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
                    });
                } catch (e) {
                    applied = { error: e?.message };
                }
            }

            sendResponse({ success: true, data: { ...result, applied } });
        } catch (error) {
            svc.errorHandler.logError('Generate PR labels', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    // ── /add-docs ────────────────────────────────────────────────────────────
    async function handleGenerateDocstrings(message, sendResponse) {
        let budget = null;
        try {
            const { prUrl } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            const { prData, settings, fileContext, declarationsByFile } = await withFileContext(prUrl);
            budget = armBudget(settings);

            const service = new DocstringService({
                llmService: svc.llmService,
                symbolExtractor: new SymbolExtractor(),
            });

            const candidates = service.findUndocumented({ prData, fileContext, declarationsByFile });
            if (!candidates.length) {
                // Say WHY there is nothing to do — "no output" from a docs command
                // is otherwise indistinguishable from a failure.
                sendResponse({
                    success: true,
                    data: {
                        docstrings: [],
                        message: 'Every declaration this PR added or changed already has a '
                            + 'documentation comment, or is too small to warrant one.',
                        stats: { candidates: 0 },
                    },
                });
                return;
            }

            const result = await service.generate({
                prData,
                fileContext,
                declarationsByFile,
                settings: {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                },
            });

            sendResponse({
                success: true,
                data: { ...result, callBudget: budget.snapshot() },
            });
        } catch (error) {
            svc.errorHandler.logError('Generate docstrings', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        } finally {
            disarmBudget();
        }
    }

    // ── /ask-line ────────────────────────────────────────────────────────────
    async function handleAskLineQuestion(message, sendResponse) {
        try {
            const { prUrl, target, question } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            const parsed = LineQuestionService.parseTarget(target);
            if (!parsed) {
                sendResponse({
                    success: false,
                    error: 'Give a target as `file.js:214`. Usage: /ask-line <file>:<line> <question>',
                });
                return;
            }
            if (!question) {
                sendResponse({ success: false, error: 'Ask a question after the line reference.' });
                return;
            }

            // Only the file being asked about is fetched — a line question has no
            // use for the other eleven files' content.
            const { prData, settings, fileContext, declarationsByFile } = await withFileContext(prUrl, {
                maxFiles: 2,
            });
            armBudget(settings);

            const service = new LineQuestionService({
                llmService: svc.llmService,
                symbolExtractor: new SymbolExtractor(),
            });

            const result = await service.ask({
                question,
                rawTarget: target,
                prData,
                fileContext,
                declarationsByFile,
                settings: {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                },
            });

            sendResponse({ success: true, data: result });
        } catch (error) {
            svc.errorHandler.logError('Ask line question', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        } finally {
            disarmBudget();
        }
    }

    // ── /history ─────────────────────────────────────────────────────────────
    async function handlePriorReviewHistory(message, sendResponse) {
        try {
            const { prUrl, findings = [] } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            await svc.updatePRServiceTokens();
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);

            const collector = svc.feedbackCollector || new FeedbackCollectorService({
                pullRequestService: svc.pullRequestService,
                adaptiveLearning: svc.adaptiveLearningService || null,
            });
            const service = new PriorFindingService({ feedbackCollector: collector });

            const repoId = svc.gitlabService?.getRepoId?.(prUrl)
                || svc.githubService?.getRepoId?.(prUrl)
                || null;

            const { findings: annotated, stats } = await service.annotate(findings, { repoId });
            const relatedPRs = await service.relatedPRs(prData, { repoId });

            const markdown = PriorFindingService.renderSection({
                annotatedFindings: annotated,
                relatedPRs,
            });

            sendResponse({
                success: true,
                data: {
                    findings: annotated,
                    relatedPRs,
                    stats,
                    markdown: markdown || 'No prior review verdicts recorded for the code this PR touches. '
                        + 'History accumulates as people tick the feedback boxes on posted review comments.',
                },
            });
        } catch (error) {
            svc.errorHandler.logError('Prior review history', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        GENERATE_PR_LABELS: (m, send) => handleGeneratePRLabels(m, send),
        GENERATE_DOCSTRINGS: (m, send) => handleGenerateDocstrings(m, send),
        ASK_LINE_QUESTION: (m, send) => handleAskLineQuestion(m, send),
        PRIOR_REVIEW_HISTORY: (m, send) => handlePriorReviewHistory(m, send),
    };
}

export default createPrToolHandlers;

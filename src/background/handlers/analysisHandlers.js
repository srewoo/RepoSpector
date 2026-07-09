/**
 * Analysis / adaptive-learning / compliance / metrics handlers, extracted from
 * BackgroundService.
 *
 * Covers: adaptive-learning action recording + stats, custom-rules config fetch,
 * knowledge-graph impact + dead-code analysis, PR-description compliance, and
 * review metrics. Shared state stays on the service instance (adaptiveLearningService,
 * telemetry, customRulesService, codeGraphPipeline, pullRequestService,
 * prComplianceChecker, reviewMetricsService, getStoredSettings, errorHandler,
 * getErrorMessage). PRComplianceChecker / ReviewMetricsService are imported for
 * their static formatters; ImpactAnalyzer is loaded on demand.
 */

import { PRComplianceChecker } from '../../services/PRComplianceChecker.js';
import { ReviewMetricsService } from '../../services/ReviewMetricsService.js';

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createAnalysisHandlers(svc) {
    async function handleRecordFindingAction(message, sendResponse) {
        try {
            const { ruleId, repoId, action, filePath, findingMessage } = message.data || message.payload || {};

            if (!ruleId || !repoId || !action) {
                sendResponse({ success: false, error: 'ruleId, repoId, and action are required' });
                return;
            }

            await svc.adaptiveLearningService.recordAction({
                ruleId,
                repoId,
                action, // 'dismissed' | 'resolved'
                filePath,
                findingMessage
            });

            // Telemetry: bump the FP-rate proxy when a finding is dismissed.
            if (action === 'dismissed') {
                try { await svc.telemetry.recordDismissal('pr_review'); } catch { /* ignore */ }
            }

            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Record Finding Action', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGetLearningStats(message, sendResponse) {
        try {
            const { repoId } = message.data || message.payload || {};

            if (!repoId) {
                sendResponse({ success: false, error: 'repoId is required' });
                return;
            }

            const stats = await svc.adaptiveLearningService.getStats(repoId);
            sendResponse({ success: true, data: stats });
        } catch (error) {
            svc.errorHandler.logError('Get Learning Stats', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleFetchCustomConfig(message, sendResponse) {
        try {
            const { platform, owner, repo, token } = message.data || message.payload || {};

            if (!platform || !owner || !repo) {
                sendResponse({ success: false, error: 'platform, owner, and repo are required' });
                return;
            }

            const config = await svc.customRulesService.fetchConfig(platform, owner, repo, token);
            sendResponse({ success: true, data: config });
        } catch (error) {
            svc.errorHandler.logError('Fetch Custom Config', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle impact analysis via knowledge graph
     */
    async function handleAnalyzeImpact(message, sendResponse) {
        const { targetName, repoId, direction = 'both' } = message.payload || message.data || {};

        try {
            if (!targetName) {
                throw new Error('Target function/class name is required');
            }

            // Load knowledge graph for this repo
            const graph = svc.codeGraphPipeline?.graph;
            if (!graph) {
                throw new Error('Knowledge graph not available. Please index the repository first.');
            }

            // Try to load the graph for this repo
            await graph.load(repoId);

            const { ImpactAnalyzer } = await import('../../services/ImpactAnalyzer.js');
            const analyzer = new ImpactAnalyzer(graph);
            const result = analyzer.analyze(targetName, { direction, maxDepth: 5 });

            if (!result.found) {
                sendResponse({
                    success: true,
                    data: {
                        response: `No symbol named "${targetName}" found in the knowledge graph. Make sure the repository is indexed and try the exact function or class name.`
                    }
                });
                return;
            }

            // Format for display
            let response = `## Impact Analysis: ${result.target.name}\n\n`;
            response += `**Type**: ${result.target.type} | **File**: ${result.target.filePath}\n`;
            response += `**Risk Level**: ${result.riskLevel.toUpperCase()}\n\n`;

            if (result.upstream && result.upstream.nodes.length > 0) {
                response += `### Upstream (${result.upstream.nodes.length} callers)\n`;
                for (const node of result.upstream.nodes.slice(0, 15)) {
                    response += `- **${node.name}** (${node.filePath}) — confidence: ${Math.round(node.confidence * 100)}%\n`;
                }
                if (result.upstream.nodes.length > 15) {
                    response += `- ... and ${result.upstream.nodes.length - 15} more\n`;
                }
                response += '\n';
            }

            if (result.downstream && result.downstream.nodes.length > 0) {
                response += `### Downstream (${result.downstream.nodes.length} dependencies)\n`;
                for (const node of result.downstream.nodes.slice(0, 15)) {
                    response += `- **${node.name}** (${node.filePath}) — confidence: ${Math.round(node.confidence * 100)}%\n`;
                }
                if (result.downstream.nodes.length > 15) {
                    response += `- ... and ${result.downstream.nodes.length - 15} more\n`;
                }
                response += '\n';
            }

            response += `### Summary\n${result.summary}`;

            sendResponse({ success: true, data: { response } });
        } catch (error) {
            console.error('Impact analysis error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle dead code analysis via knowledge graph
     */
    async function handleAnalyzeDeadCode(message, sendResponse) {
        const { repoId } = message.payload || message.data || {};

        try {
            const graph = svc.codeGraphPipeline?.graph;
            if (!graph) {
                throw new Error('Knowledge graph not available. Please index the repository first.');
            }

            await graph.load(repoId);

            // Find nodes with no incoming edges (potential dead code)
            const reverseAdj = graph.getReverseAdjacency();
            const allNodes = graph.getAllNodes();
            const deadCandidates = [];

            for (const node of allNodes) {
                // Skip if it's an entry point (exported, main, handler, etc.)
                const name = (node.properties?.name || '').toLowerCase();
                const isEntryPoint = name.includes('main') || name.includes('handler') ||
                    name.includes('controller') || name.includes('export') ||
                    name.includes('route') || name.includes('middleware') ||
                    name.includes('test') || name.includes('spec');

                if (isEntryPoint) continue;

                // Check if no callers
                const callers = reverseAdj.get(node.id) || [];
                if (callers.length === 0 && node.label !== 'Module') {
                    deadCandidates.push({
                        name: node.properties?.name,
                        type: node.label,
                        filePath: node.properties?.filePath,
                        line: node.properties?.startLine
                    });
                }
            }

            let response = `## Dead Code Analysis\n\n`;
            response += `Found **${deadCandidates.length}** potentially unused symbols:\n\n`;

            if (deadCandidates.length === 0) {
                response += 'No dead code candidates found. All symbols appear to have callers.\n';
            } else {
                for (const candidate of deadCandidates.slice(0, 30)) {
                    response += `- **${candidate.name}** (${candidate.type}) in \`${candidate.filePath}:${candidate.line || '?'}\`\n`;
                }
                if (deadCandidates.length > 30) {
                    response += `\n... and ${deadCandidates.length - 30} more.\n`;
                }
                response += '\n*Note: Entry points (handlers, controllers, exports, tests) are excluded. Verify before removing.*';
            }

            sendResponse({ success: true, data: { response } });
        } catch (error) {
            console.error('Dead code analysis error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle PR description compliance check
     */
    async function handleCheckPRCompliance(message, sendResponse) {
        const { prUrl, repoId } = message.payload || message.data || {};

        try {
            if (!prUrl) throw new Error('PR URL is required');

            const settings = await svc.getStoredSettings();

            // Fetch PR data
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl, {
                githubToken: settings.githubToken,
                gitlabToken: settings.gitlabToken
            });

            // Fetch custom rules if available
            let customRules = null;
            if (repoId) {
                const parts = repoId.split('/');
                const platform = prUrl.includes('gitlab') ? 'gitlab' : 'github';
                const token = platform === 'github' ? settings.githubToken : settings.gitlabToken;
                customRules = await svc.customRulesService.fetchConfig(platform, parts[0], parts[1], token);
            }

            const report = svc.prComplianceChecker.check(prData, customRules);
            const formatted = PRComplianceChecker.formatReport(report);

            sendResponse({ success: true, data: { response: formatted, report } });
        } catch (error) {
            console.error('PR compliance check error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Handle review metrics retrieval
     */
    async function handleGetReviewMetrics(message, sendResponse) {
        const { repoId } = message.payload || message.data || {};

        try {
            const metrics = await svc.reviewMetricsService.getMetrics(repoId || 'all', 30);
            const formatted = ReviewMetricsService.formatMetrics(metrics, repoId || 'all repos');

            sendResponse({ success: true, data: { response: formatted, metrics } });
        } catch (error) {
            console.error('Review metrics error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        RECORD_FINDING_ACTION: handleRecordFindingAction,
        GET_LEARNING_STATS: handleGetLearningStats,
        FETCH_CUSTOM_CONFIG: handleFetchCustomConfig,
        ANALYZE_IMPACT: handleAnalyzeImpact,
        ANALYZE_DEAD_CODE: handleAnalyzeDeadCode,
        CHECK_PR_COMPLIANCE: handleCheckPRCompliance,
        GET_REVIEW_METRICS: handleGetReviewMetrics,
    };
}

/**
 * ImpactAnalyzer for RepoSpector
 *
 * Provides blast-radius analysis by walking the knowledge graph's CALLS edges.
 * Answers: "What will break if I change function X?"
 *
 * Features:
 *   - Upstream analysis: who depends on X (will break)
 *   - Downstream analysis: what does X depend on
 *   - Depth-grouped results with confidence scoring
 *   - Risk level calculation
 *   - LLM-ready formatted output for chat context injection
 *
 * Inspired by GitNexus's impact() tool.
 */

const CONFIDENCE_LABELS = {
    high: { min: 0.8, label: 'WILL BREAK' },
    medium: { min: 0.5, label: 'LIKELY AFFECTED' },
    low: { min: 0.0, label: 'POSSIBLY AFFECTED' }
};

export class ImpactAnalyzer {
    /**
     * @param {import('./KnowledgeGraphService.js').KnowledgeGraphService} graph
     */
    constructor(graph) {
        this.graph = graph;
    }

    /**
     * Full impact analysis for a target symbol
     *
     * @param {string} targetName - Function/class name to analyze
     * @param {Object} options
     * @param {string} options.direction - 'upstream' | 'downstream' | 'both'
     * @param {number} options.maxDepth - Max traversal depth (default: 5)
     * @param {number} options.minConfidence - Minimum confidence threshold (default: 0.0)
     * @param {boolean} options.includeTests - Include test files (default: false)
     * @returns {Object} Impact analysis result
     */
    analyze(targetName, options = {}) {
        const {
            direction = 'both',
            maxDepth = 5,
            minConfidence = 0.0,
            includeTests = false
        } = options;

        const targetNodes = this.graph.findNodeByName(targetName);
        if (targetNodes.length === 0) {
            return { found: false, target: targetName, message: `No symbol named "${targetName}" found in the knowledge graph.` };
        }

        const target = targetNodes[0];
        const result = {
            found: true,
            target: {
                name: target.properties.name,
                type: target.label,
                filePath: target.properties.filePath,
                startLine: target.properties.startLine
            },
            upstream: null,
            downstream: null,
            riskLevel: 'low',
            summary: ''
        };

        if (direction === 'upstream' || direction === 'both') {
            result.upstream = this._walkUpstream(target.id, maxDepth, minConfidence, includeTests);
        }

        if (direction === 'downstream' || direction === 'both') {
            result.downstream = this._walkDownstream(target.id, maxDepth, minConfidence, includeTests);
        }

        result.riskLevel = this._calculateRisk(result);
        result.summary = this._buildSummary(result);

        return result;
    }

    /**
     * Walk upstream: find everything that depends on this symbol (callers)
     */
    _walkUpstream(targetId, maxDepth, minConfidence, includeTests) {
        const reverseAdj = this.graph.getReverseAdjacency();
        return this._bfsWalk(targetId, reverseAdj, 'sourceId', maxDepth, minConfidence, includeTests);
    }

    /**
     * Walk downstream: find everything this symbol depends on (callees)
     */
    _walkDownstream(targetId, maxDepth, minConfidence, includeTests) {
        const forwardAdj = this.graph.getForwardAdjacency();
        return this._bfsWalk(targetId, forwardAdj, 'targetId', maxDepth, minConfidence, includeTests);
    }

    /**
     * BFS walk through adjacency list, grouping by depth
     */
    _bfsWalk(startId, adjacencyMap, neighborKey, maxDepth, minConfidence, includeTests) {
        const visited = new Set([startId]);
        const depthGroups = {};
        let queue = [{ id: startId, depth: 0, confidence: 1.0 }];
        let totalAffected = 0;

        while (queue.length > 0) {
            const nextQueue = [];

            for (const { id, depth, confidence: pathConfidence } of queue) {
                if (depth >= maxDepth) continue;

                const neighbors = adjacencyMap.get(id) || [];

                for (const neighbor of neighbors) {
                    const neighborId = neighbor[neighborKey];
                    if (visited.has(neighborId)) continue;

                    const edgeConfidence = neighbor.confidence || 0.5;
                    const combinedConfidence = Math.min(pathConfidence, edgeConfidence);

                    if (combinedConfidence < minConfidence) continue;

                    const node = this.graph.getNode(neighborId);
                    if (!node) continue;

                    const filePath = node.properties?.filePath || '';
                    if (!includeTests && this._isTestFile(filePath)) continue;

                    visited.add(neighborId);
                    totalAffected++;

                    const depthKey = depth + 1;
                    if (!depthGroups[depthKey]) depthGroups[depthKey] = [];

                    depthGroups[depthKey].push({
                        name: node.properties?.name || 'unknown',
                        type: node.label,
                        filePath,
                        startLine: node.properties?.startLine,
                        confidence: combinedConfidence,
                        confidenceLabel: this._getConfidenceLabel(combinedConfidence),
                        reason: neighbor.reason || 'calls'
                    });

                    nextQueue.push({ id: neighborId, depth: depthKey, confidence: combinedConfidence });
                }
            }

            queue = nextQueue;
        }

        return {
            totalAffected,
            depthGroups,
            maxDepthReached: Object.keys(depthGroups).length
        };
    }

    _getConfidenceLabel(confidence) {
        if (confidence >= CONFIDENCE_LABELS.high.min) return CONFIDENCE_LABELS.high.label;
        if (confidence >= CONFIDENCE_LABELS.medium.min) return CONFIDENCE_LABELS.medium.label;
        return CONFIDENCE_LABELS.low.label;
    }

    _calculateRisk(result) {
        const upstreamCount = result.upstream?.totalAffected || 0;
        const highConfCount = this._countHighConfidence(result.upstream);

        if (highConfCount >= 10 || upstreamCount >= 20) return 'critical';
        if (highConfCount >= 5 || upstreamCount >= 10) return 'high';
        if (highConfCount >= 2 || upstreamCount >= 5) return 'medium';
        return 'low';
    }

    _countHighConfidence(walkResult) {
        if (!walkResult?.depthGroups) return 0;
        let count = 0;
        for (const group of Object.values(walkResult.depthGroups)) {
            count += group.filter(n => n.confidence >= 0.8).length;
        }
        return count;
    }

    _isTestFile(filePath) {
        const lower = filePath.toLowerCase();
        return lower.includes('test') || lower.includes('spec') ||
               lower.includes('__tests__') || lower.includes('__mocks__') ||
               lower.endsWith('.test.js') || lower.endsWith('.spec.js') ||
               lower.endsWith('.test.ts') || lower.endsWith('.spec.ts') ||
               lower.endsWith('_test.py') || lower.endsWith('_test.go');
    }

    _buildSummary(result) {
        const parts = [];
        const t = result.target;
        parts.push(`TARGET: ${t.type} ${t.name} (${t.filePath})`);

        if (result.upstream) {
            parts.push(`\nUPSTREAM (what depends on this): ${result.upstream.totalAffected} symbol(s)`);
        }
        if (result.downstream) {
            parts.push(`DOWNSTREAM (what this depends on): ${result.downstream.totalAffected} symbol(s)`);
        }
        parts.push(`\nRISK LEVEL: ${result.riskLevel.toUpperCase()}`);

        return parts.join('\n');
    }

    /**
     * Format impact analysis as a prompt section for LLM context injection
     */
    formatForPrompt(targetName, options = {}) {
        const result = this.analyze(targetName, options);

        if (!result.found) return null;

        let prompt = `## Impact Analysis: ${targetName}\n\n`;
        prompt += `**TARGET**: ${result.target.type} \`${result.target.name}\` (${result.target.filePath}:${result.target.startLine || '?'})\n`;
        prompt += `**RISK LEVEL**: ${result.riskLevel.toUpperCase()}\n\n`;

        if (result.upstream && result.upstream.totalAffected > 0) {
            prompt += `### UPSTREAM — What will break if this changes (${result.upstream.totalAffected} symbols):\n`;

            for (const [depth, items] of Object.entries(result.upstream.depthGroups)) {
                prompt += `\n**Depth ${depth}**:\n`;

                for (const item of items.slice(0, 15)) {
                    const conf = (item.confidence * 100).toFixed(0);
                    prompt += `- \`${item.name}\` [${item.type}] → ${item.filePath}:${item.startLine || '?'} (${conf}% confidence — ${item.confidenceLabel})\n`;
                }

                if (items.length > 15) {
                    prompt += `- ... and ${items.length - 15} more\n`;
                }
            }
        }

        if (result.downstream && result.downstream.totalAffected > 0) {
            prompt += `\n### DOWNSTREAM — What this depends on (${result.downstream.totalAffected} symbols):\n`;

            for (const [depth, items] of Object.entries(result.downstream.depthGroups)) {
                prompt += `\n**Depth ${depth}**:\n`;

                for (const item of items.slice(0, 10)) {
                    const conf = (item.confidence * 100).toFixed(0);
                    prompt += `- \`${item.name}\` [${item.type}] → ${item.filePath}:${item.startLine || '?'} (${conf}%)\n`;
                }

                if (items.length > 10) {
                    prompt += `- ... and ${items.length - 10} more\n`;
                }
            }
        }

        return prompt;
    }

    /**
     * Quick check: is it safe to change this symbol?
     * Returns a concise verdict for chat responses.
     */
    quickSafetyCheck(targetName) {
        const result = this.analyze(targetName, { direction: 'upstream', maxDepth: 3 });

        if (!result.found) return { safe: true, reason: 'Symbol not found in graph — likely safe but untracked.' };

        const count = result.upstream?.totalAffected || 0;
        const highConf = this._countHighConfidence(result.upstream);

        if (count === 0) return { safe: true, reason: 'No upstream dependencies found. Safe to change.', risk: 'low' };
        if (highConf === 0 && count <= 2) return { safe: true, reason: `Only ${count} low-confidence dependency(s). Likely safe with testing.`, risk: 'low' };
        if (highConf <= 2) return { safe: false, reason: `${highConf} high-confidence + ${count - highConf} other callers. Review before changing.`, risk: 'medium' };

        return {
            safe: false,
            reason: `${highConf} high-confidence callers will break. ${count} total affected. Careful refactoring required.`,
            risk: result.riskLevel
        };
    }
}

export default ImpactAnalyzer;

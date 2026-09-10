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

import { isTestFile } from './testFileUtils.js';

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

        // ALL definitions of this name, not just the first.
        //
        // This used to be `targetNodes[0]`, silently analysing one arbitrary
        // definition and discarding the rest. Method names repeat constantly
        // across types — gorilla/mux alone declares `Match` on `Route`,
        // `Router` and `routeRegexp` — so "what breaks if I change Match"
        // answered for whichever happened to be indexed first, with nothing in
        // the output saying a choice had been made.
        //
        // The walks below are UNIONED across the matches. For a safety question
        // that is the conservative direction: it over-reports the blast radius
        // rather than under-reporting it, and `ambiguous`/`targets` tell the
        // caller the answer spans several declarations so they can disambiguate
        // with get_symbol when the distinction matters.
        const describe = (n) => ({
            name: n.properties.name,
            type: n.label,
            filePath: n.properties.filePath,
            startLine: n.properties.startLine
        });
        const target = targetNodes[0];
        const result = {
            found: true,
            target: describe(target),
            targets: targetNodes.map(describe),
            ambiguous: targetNodes.length > 1,
            upstream: null,
            downstream: null,
            riskLevel: 'low',
            summary: ''
        };

        const ids = targetNodes.map((n) => n.id);

        if (direction === 'upstream' || direction === 'both') {
            result.upstream = this._mergeWalks(
                ids.map((id) => this._walkUpstream(id, maxDepth, minConfidence, includeTests)),
                new Set(ids)
            );
        }

        if (direction === 'downstream' || direction === 'both') {
            result.downstream = this._mergeWalks(
                ids.map((id) => this._walkDownstream(id, maxDepth, minConfidence, includeTests)),
                new Set(ids)
            );
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
        let untestedCount = 0;

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

                    const isTested = node.properties?.isTested === true;
                    if (!isTested) untestedCount++;

                    const depthKey = depth + 1;
                    if (!depthGroups[depthKey]) depthGroups[depthKey] = [];

                    depthGroups[depthKey].push({
                        // Carried so `_mergeWalks` can drop the other
                        // definitions of an overloaded name from its own blast
                        // radius; also lets callers re-look-up the node.
                        id: neighborId,
                        name: node.properties?.name || 'unknown',
                        type: node.label,
                        filePath,
                        startLine: node.properties?.startLine,
                        confidence: combinedConfidence,
                        confidenceLabel: this._getConfidenceLabel(combinedConfidence),
                        reason: neighbor.reason || 'calls',
                        isTested,
                        isExported: node.properties?.isExported === true
                    });

                    nextQueue.push({ id: neighborId, depth: depthKey, confidence: combinedConfidence });
                }
            }

            queue = nextQueue;
        }

        return {
            totalAffected,
            untestedCount,
            depthGroups,
            maxDepthReached: Object.keys(depthGroups).length
        };
    }

    /**
     * Union several walks into one result, de-duplicating symbols reached from
     * more than one definition of an overloaded name.
     *
     * A symbol reached at two different depths is kept at the SHALLOWEST one —
     * the shortest path is the one a reader needs — and at the highest
     * confidence any path gave it, since one uncertain route to a symbol does
     * not make a certain route less certain.
     *
     * Single-walk callers get the same shape back, so this is safe to apply
     * unconditionally.
     */
    _mergeWalks(walks, targetIds = new Set()) {
        const best = new Map();

        for (const walk of walks) {
            for (const [depthKey, group] of Object.entries(walk?.depthGroups || {})) {
                const depth = Number(depthKey);
                for (const entry of group) {
                    const key = `${entry.filePath}::${entry.name}::${entry.startLine ?? '?'}`;
                    const prior = best.get(key);
                    if (!prior) {
                        best.set(key, { entry: { ...entry }, depth });
                        continue;
                    }
                    if (entry.confidence > prior.entry.confidence) {
                        prior.entry = { ...entry };
                    }
                    if (depth < prior.depth) prior.depth = depth;
                }
            }
        }

        const depthGroups = {};
        let totalAffected = 0;
        let untestedCount = 0;

        for (const { entry, depth } of best.values()) {
            // A definition of the analysed name is not its own dependent: with
            // several overloads, each walk reaches the others and they would
            // otherwise inflate the blast radius by the overload count.
            if (targetIds.has(entry.id)) continue;
            if (!depthGroups[depth]) depthGroups[depth] = [];
            depthGroups[depth].push(entry);
            totalAffected += 1;
            if (!entry.isTested) untestedCount += 1;
        }

        return {
            totalAffected,
            untestedCount,
            depthGroups,
            maxDepthReached: Object.keys(depthGroups).length
        };
    }

    /**
     * Untested symbols in a change's blast radius — the highest-signal input for
     * test generation. Returns the upstream-affected symbols that have no test
     * coverage, so callers can prioritise writing tests where a change is risky.
     */
    findUntestedInBlastRadius(targetName, options = {}) {
        const result = this.analyze(targetName, {
            direction: 'upstream',
            maxDepth: options.maxDepth || 3,
            minConfidence: options.minConfidence ?? 0.3
        });
        if (!result.found || !result.upstream) return { found: result.found, untested: [] };

        const untested = [];
        for (const items of Object.values(result.upstream.depthGroups)) {
            for (const item of items) {
                if (!item.isTested) untested.push(item);
            }
        }
        return {
            found: true,
            target: result.target,
            totalAffected: result.upstream.totalAffected,
            untested
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

    /**
     * @param {object} walkResult
     * @param {number} [threshold] confidence bar; defaults to the static 0.8.
     */
    _countHighConfidence(walkResult, threshold = CONFIDENCE_LABELS.high.min) {
        if (!walkResult?.depthGroups) return 0;
        let count = 0;
        for (const group of Object.values(walkResult.depthGroups)) {
            count += group.filter(n => n.confidence >= threshold).length;
        }
        return count;
    }

    /**
     * What confidence actually looks like in this walk.
     *
     * The static 0.8 bar assumes an extractor that emits a spread of
     * confidences. The Go extractor emits a flat 0.5 for every CALLS edge, so
     * the bar was unreachable and "no high-confidence callers" meant nothing.
     * Reporting the observed spread lets the verdict say which of the two it is
     * rather than silently treating them alike.
     *
     * The bar is never lowered below the observed maximum: a graph whose best
     * edge is 0.5 has its bar at 0.5, so its strongest evidence still counts,
     * while a graph that does emit 0.9s keeps the strict 0.8.
     */
    _confidenceCalibration(walkResult) {
        const values = [];
        for (const group of Object.values(walkResult?.depthGroups || {})) {
            for (const n of group) {
                if (Number.isFinite(n.confidence)) values.push(n.confidence);
            }
        }
        const staticBar = CONFIDENCE_LABELS.high.min;
        if (values.length === 0) {
            return { observedMax: null, observedMin: null, highThreshold: staticBar, uniformlyLow: false };
        }
        const observedMax = Math.max(...values);
        const observedMin = Math.min(...values);
        const uniformlyLow = observedMax < staticBar;
        return {
            observedMax,
            observedMin,
            // Never above the static bar, never above what this graph can produce.
            highThreshold: uniformlyLow ? observedMax : staticBar,
            uniformlyLow
        };
    }

    /**
     * Dependents that are exported API surface.
     *
     * Centrality proxy: a symbol whose blast radius touches the public surface
     * is reachable from outside the module however few direct callers the graph
     * linked, which is exactly the case cardinality alone gets wrong.
     */
    _countExportedDependents(walkResult) {
        if (!walkResult?.depthGroups) return 0;
        let count = 0;
        for (const group of Object.values(walkResult.depthGroups)) {
            count += group.filter(n => n.isExported === true).length;
        }
        return count;
    }

    _isTestFile(filePath) {
        return isTestFile(filePath);
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
            prompt += `### UPSTREAM — What will break if this changes (${result.upstream.totalAffected} symbols`;
            if (result.upstream.untestedCount > 0) {
                prompt += `, ${result.upstream.untestedCount} UNTESTED`;
            }
            prompt += `):\n`;

            for (const [depth, items] of Object.entries(result.upstream.depthGroups)) {
                prompt += `\n**Depth ${depth}**:\n`;

                for (const item of items.slice(0, 15)) {
                    const conf = (item.confidence * 100).toFixed(0);
                    const cov = item.isTested ? '' : ' ⚠️ UNTESTED';
                    prompt += `- \`${item.name}\` [${item.type}] → ${item.filePath}:${item.startLine || '?'} (${conf}% confidence — ${item.confidenceLabel})${cov}\n`;
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
    /**
     * Fast "is this safe to change?" verdict.
     *
     * Two rules changed here, both because the old version called
     * `gorilla/mux`'s `setMatch` SAFE. That function has exactly one caller —
     * `Route.Match` — which `ServeHTTP` reaches on every request the router
     * serves. It is about as far from safe as a function gets.
     *
     * 1. LOW CONFIDENCE IS NOT SAFETY. The old rule returned `safe: true` when
     *    `highConf === 0 && count <= 2`, and `_countHighConfidence` demanded
     *    `>= 0.8`. Every Go CALLS edge this analyser produces is `0.5`, so
     *    `highConf` was structurally always 0 for Go and ANY Go symbol with two
     *    or fewer callers was declared safe. Uncertainty about an edge is
     *    absence of evidence, not evidence of absence — the same principle the
     *    review bundle states about its own retrieval. Only a genuinely empty
     *    blast radius is safe now.
     *
     * 2. CARDINALITY IS NOT CENTRALITY. One caller on a request hot path
     *    outranks five in leaf utilities, so reaching exported API surface
     *    escalates risk regardless of how few callers there are.
     *
     * `calibration` reports the confidence spread actually observed, so a
     * reader can tell "no high-confidence callers" (a real finding) from "this
     * parser never emits high confidence" (a property of the extractor).
     */
    quickSafetyCheck(targetName, options = {}) {
        const maxDepth = options.maxDepth || 3;
        const result = this.analyze(targetName, { direction: 'upstream', maxDepth });

        if (!result.found) {
            return { safe: true, reason: 'Symbol not found in graph — likely safe but untracked.' };
        }

        const upstream = result.upstream;
        const count = upstream?.totalAffected || 0;
        const calibration = this._confidenceCalibration(upstream);
        const highConf = this._countHighConfidence(upstream, calibration.highThreshold);
        const exported = this._countExportedDependents(upstream);

        const base = {
            risk: result.riskLevel,
            dependents: count,
            highConfidence: highConf,
            exportedDependents: exported,
            ambiguous: result.ambiguous === true,
            targets: result.targets,
            calibration
        };

        if (count === 0) {
            return { ...base, safe: true, risk: 'low', reason: 'No upstream dependencies found. Safe to change.' };
        }

        // Anything on exported API surface is at least medium, however few
        // callers the graph managed to link.
        if (exported > 0 && count <= 2) {
            return {
                ...base,
                safe: false,
                risk: base.risk === 'low' ? 'medium' : base.risk,
                reason: `${count} dependency(s), ${exported} of them exported API. Few callers, but the change reaches the public surface — review before changing.`
            };
        }

        if (highConf === 0) {
            return {
                ...base,
                safe: false,
                risk: base.risk === 'low' ? 'medium' : base.risk,
                reason: `${count} dependency(s), none above the ${calibration.highThreshold.toFixed(2)} confidence bar${calibration.uniformlyLow ? ' (this graph emits no edge above that bar, so the bar says nothing about this symbol)' : ''}. Unverified, not safe — review before changing.`
            };
        }

        if (highConf <= 2) {
            return {
                ...base,
                safe: false,
                risk: base.risk === 'low' ? 'medium' : base.risk,
                reason: `${highConf} high-confidence + ${count - highConf} other callers. Review before changing.`
            };
        }

        return {
            ...base,
            safe: false,
            reason: `${highConf} high-confidence callers will break. ${count} total affected. Careful refactoring required.`
        };
    }
}

export default ImpactAnalyzer;

/**
 * ProcessTracer for RepoSpector
 *
 * Detects execution flows (processes) in the knowledge graph by:
 *   1. Scoring entry points (functions with high outgoing / low incoming calls)
 *   2. BFS forward tracing through CALLS edges
 *   3. Deduplicating overlapping traces
 *   4. Labeling processes with heuristic names (EntryFn → TerminalFn)
 *
 * Processes help the LLM understand how features work across the codebase,
 * e.g. "LoginFlow: handleLogin → validateUser → checkPassword → createSession"
 *
 * Inspired by GitNexus's process-processor.
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';

const DEFAULT_CONFIG = {
    maxTraceDepth: 10,
    maxBranching: 4,
    maxProcesses: 75,
    minSteps: 2
};

const ENTRY_POINT_NAME_PATTERNS = [
    /^handle[A-Z]/, /^on[A-Z]/, /^process[A-Z]/, /^execute[A-Z]/,
    /^run[A-Z]/, /^start[A-Z]/, /^init[A-Z]/, /^setup[A-Z]/,
    /^main$/, /^app$/, /^server$/,
    /Controller$/, /Handler$/, /Router$/, /Middleware$/,
    /^get[A-Z]/, /^post[A-Z]/, /^put[A-Z]/, /^delete[A-Z]/, /^patch[A-Z]/,
    /^create[A-Z]/, /^update[A-Z]/, /^remove[A-Z]/,
    /^api[A-Z]/, /^route[A-Z]/
];

export class ProcessTracer {
    /**
     * @param {import('./KnowledgeGraphService.js').KnowledgeGraphService} graph
     */
    constructor(graph) {
        this.graph = graph;
    }

    /**
     * Detect all execution flows in the knowledge graph
     *
     * @param {Object} communityMemberships - Map of nodeId → communityId (optional, from CommunityDetector)
     * @param {Partial<typeof DEFAULT_CONFIG>} config
     * @returns {Object} ProcessDetectionResult
     */
    detect(communityMemberships = new Map(), config = {}) {
        const cfg = { ...DEFAULT_CONFIG, ...config };

        const forwardAdj = this.graph.getForwardAdjacency();
        const reverseAdj = this.graph.getReverseAdjacency();

        // Step 1: Find and score entry points
        const entryPoints = this._findEntryPoints(forwardAdj, reverseAdj);

        // Step 2: Trace from each entry point
        const allTraces = [];

        for (let i = 0; i < entryPoints.length && allTraces.length < cfg.maxProcesses * 2; i++) {
            const entryId = entryPoints[i].id;
            const traces = this._traceFromEntryPoint(entryId, forwardAdj, cfg);

            for (const trace of traces) {
                if (trace.length >= cfg.minSteps) {
                    allTraces.push(trace);
                }
            }
        }

        // Step 3: Deduplicate
        const uniqueTraces = this._deduplicateTraces(allTraces);

        // Step 4: Limit and sort by length (longer = more interesting)
        const limited = uniqueTraces
            .sort((a, b) => b.length - a.length)
            .slice(0, cfg.maxProcesses);

        // Step 5: Build process nodes and steps
        const processes = [];
        const steps = [];

        for (let idx = 0; idx < limited.length; idx++) {
            const trace = limited[idx];
            const entryPointId = trace[0];
            const terminalId = trace[trace.length - 1];

            const communitiesSet = new Set();
            for (const nodeId of trace) {
                const comm = communityMemberships.get(nodeId);
                if (comm) communitiesSet.add(comm);
            }
            const communities = Array.from(communitiesSet);

            const entryNode = this.graph.getNode(entryPointId);
            const terminalNode = this.graph.getNode(terminalId);
            const entryName = entryNode?.properties?.name || 'Unknown';
            const terminalName = terminalNode?.properties?.name || 'Unknown';

            const processId = `proc_${idx}_${this._sanitize(entryName)}`;
            const heuristicLabel = `${this._capitalize(entryName)} → ${this._capitalize(terminalName)}`;

            processes.push({
                id: processId,
                label: heuristicLabel,
                heuristicLabel,
                processType: communities.length > 1 ? 'cross_community' : 'intra_community',
                stepCount: trace.length,
                communities,
                entryPointId,
                terminalId,
                trace
            });

            for (let stepIdx = 0; stepIdx < trace.length; stepIdx++) {
                steps.push({
                    nodeId: trace[stepIdx],
                    processId,
                    step: stepIdx + 1
                });
            }
        }

        // Step 6: Add process nodes and STEP_IN_PROCESS edges to graph
        for (const proc of processes) {
            this.graph.addNode({
                id: proc.id,
                label: 'Process',
                properties: {
                    name: proc.label,
                    filePath: '',
                    heuristicLabel: proc.heuristicLabel,
                    processType: proc.processType,
                    stepCount: proc.stepCount,
                    communities: proc.communities,
                    entryPointId: proc.entryPointId,
                    terminalId: proc.terminalId
                }
            });
        }

        for (const step of steps) {
            this.graph.addRelationship({
                id: `${step.nodeId}_step_${step.step}_${step.processId}`,
                sourceId: step.nodeId,
                targetId: step.processId,
                type: 'STEP_IN_PROCESS',
                confidence: 1.0,
                reason: 'trace-detection',
                step: step.step
            });
        }

        const crossCommunityCount = processes.filter(p => p.processType === 'cross_community').length;
        const avgStepCount = processes.length > 0
            ? processes.reduce((sum, p) => sum + p.stepCount, 0) / processes.length
            : 0;

        return {
            processes,
            steps,
            stats: {
                totalProcesses: processes.length,
                crossCommunityCount,
                avgStepCount: Math.round(avgStepCount * 10) / 10,
                entryPointsFound: entryPoints.length
            }
        };
    }

    /**
     * Find symbols that are good entry points for tracing.
     * Scored by: outgoing calls, exported status, name patterns, caller count.
     */
    _findEntryPoints(forwardAdj, reverseAdj) {
        const symbolTypes = new Set(['Function', 'Method']);
        const candidates = [];

        for (const node of this.graph.nodes.values()) {
            if (!symbolTypes.has(node.label)) continue;

            const filePath = node.properties?.filePath || '';
            if (this._isTestFile(filePath)) continue;

            const callers = reverseAdj.get(node.id) || [];
            const callees = forwardAdj.get(node.id) || [];

            if (callees.length === 0) continue;

            let score = 0;
            const reasons = [];

            // Call ratio: more outgoing, fewer incoming = better entry point
            const callRatio = callees.length / (callers.length + 1);
            score += Math.min(callRatio * 2, 5);
            reasons.push(`ratio:${callRatio.toFixed(1)}`);

            // Zero callers bonus
            if (callers.length === 0) {
                score += 3;
                reasons.push('no-callers');
            }

            // Exported bonus
            if (node.properties?.isExported) {
                score += 2;
                reasons.push('exported');
            }

            // Name pattern bonus
            const name = node.properties?.name || '';
            for (const pattern of ENTRY_POINT_NAME_PATTERNS) {
                if (pattern.test(name)) {
                    score += 2;
                    reasons.push('name-pattern');
                    break;
                }
            }

            // File path bonus (routers, controllers, handlers)
            const lowerPath = filePath.toLowerCase();
            if (lowerPath.includes('route') || lowerPath.includes('controller') ||
                lowerPath.includes('handler') || lowerPath.includes('api/') ||
                lowerPath.includes('endpoint')) {
                score += 1.5;
                reasons.push('path-pattern');
            }

            if (score > 0) {
                candidates.push({ id: node.id, score, reasons });
            }
        }

        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, 200);
    }

    /**
     * BFS forward trace from an entry point, returning all distinct paths
     */
    _traceFromEntryPoint(entryId, forwardAdj, config) {
        const traces = [];
        const queue = [[entryId, [entryId]]]; // [currentId, pathSoFar]

        while (queue.length > 0 && traces.length < config.maxBranching * 3) {
            const [currentId, path] = queue.shift();
            const callees = forwardAdj.get(currentId) || [];

            if (callees.length === 0 || path.length >= config.maxTraceDepth) {
                if (path.length >= config.minSteps) {
                    traces.push([...path]);
                }
                continue;
            }

            const limited = callees
                .map(c => c.targetId)
                .slice(0, config.maxBranching);

            let addedBranch = false;

            for (const calleeId of limited) {
                if (!path.includes(calleeId)) {
                    queue.push([calleeId, [...path, calleeId]]);
                    addedBranch = true;
                }
            }

            if (!addedBranch && path.length >= config.minSteps) {
                traces.push([...path]);
            }
        }

        return traces;
    }

    /**
     * Remove traces that are subsets of longer traces
     */
    _deduplicateTraces(traces) {
        if (traces.length === 0) return [];

        const sorted = [...traces].sort((a, b) => b.length - a.length);
        const unique = [];

        for (const trace of sorted) {
            const traceKey = trace.join('->');
            const isSubset = unique.some(existing => existing.join('->').includes(traceKey));
            if (!isSubset) unique.push(trace);
        }

        return unique;
    }

    /**
     * Format processes as prompt section for LLM context injection
     */
    formatForPrompt(targetName) {
        const targetNodes = this.graph.findNodeByName(targetName);
        if (targetNodes.length === 0) return null;

        const targetId = targetNodes[0].id;
        const processRels = this.graph.getRelationshipsFrom(targetId)
            .filter(r => r.type === 'STEP_IN_PROCESS');

        if (processRels.length === 0) {
            // Also check if target appears as step in any process
            const incomingRels = this.graph.getRelationshipsTo(targetId)
                .filter(r => r.type === 'STEP_IN_PROCESS');
            if (incomingRels.length === 0) return null;
        }

        // Find all processes this symbol participates in
        const participatingProcesses = [];
        for (const rel of this.graph.relationships.values()) {
            if (rel.type === 'STEP_IN_PROCESS' && rel.sourceId === targetId) {
                const proc = this.graph.getNode(rel.targetId);
                if (proc) {
                    participatingProcesses.push({
                        process: proc,
                        step: rel.step
                    });
                }
            }
        }

        if (participatingProcesses.length === 0) return null;

        let prompt = `## Execution Flows containing \`${targetName}\`:\n\n`;

        for (const { process: proc, step } of participatingProcesses.slice(0, 5)) {
            const stepCount = proc.properties?.stepCount || '?';
            const type = proc.properties?.processType === 'cross_community' ? '(cross-module)' : '(internal)';
            prompt += `- **${proc.properties?.heuristicLabel || proc.properties?.name}** ${type} — step ${step}/${stepCount}\n`;

            // Show the full trace
            const traceSteps = [];
            for (const rel of this.graph.relationships.values()) {
                if (rel.type === 'STEP_IN_PROCESS' && rel.targetId === proc.id) {
                    const node = this.graph.getNode(rel.sourceId);
                    if (node) {
                        traceSteps.push({ step: rel.step, name: node.properties?.name || '?', filePath: node.properties?.filePath });
                    }
                }
            }
            traceSteps.sort((a, b) => a.step - b.step);
            const traceStr = traceSteps.map(s => s.name).join(' → ');
            prompt += `  Flow: ${traceStr}\n`;
        }

        if (participatingProcesses.length > 5) {
            prompt += `\n... and ${participatingProcesses.length - 5} more flows\n`;
        }

        return prompt;
    }

    _isTestFile(filePath) {
        const lower = filePath.toLowerCase();
        return lower.includes('test') || lower.includes('spec') ||
               lower.includes('__tests__') || lower.includes('__mocks__');
    }

    _capitalize(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    _sanitize(s) {
        return s.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20).toLowerCase();
    }
}

export default ProcessTracer;

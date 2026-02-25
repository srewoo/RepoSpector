/**
 * CodeGraphPipeline for RepoSpector
 *
 * Orchestrates the full knowledge graph construction pipeline:
 *   1. Symbol extraction (functions, classes, methods)
 *   2. Import resolution (file → IMPORTS → file)
 *   3. Call graph building (function → CALLS → function with confidence)
 *   4. Heritage resolution (class → EXTENDS/IMPLEMENTS → class)
 *   5. Community detection (Louvain clustering)
 *   6. Process tracing (execution flow detection)
 *
 * Runs during repository indexing alongside RAG embedding.
 * Graph is persisted to IndexedDB for fast loading during chat.
 *
 * Provides query methods for chat context injection:
 *   - Impact analysis (blast radius)
 *   - Process/flow context
 *   - Community membership
 *   - Symbol 360-degree view
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';
import { SymbolExtractor } from './SymbolExtractor.js';
import { CallGraphBuilder } from './CallGraphBuilder.js';
import { ImpactAnalyzer } from './ImpactAnalyzer.js';
import { ProcessTracer } from './ProcessTracer.js';
import { CommunityDetector } from './CommunityDetector.js';

export class CodeGraphPipeline {
    constructor() {
        this.graph = new KnowledgeGraphService();
        this.symbolExtractor = new SymbolExtractor();
        this.impactAnalyzer = null;
        this.processTracer = null;
        this.communityDetector = null;
        this._lastBuildStats = null;
    }

    /**
     * Build the full knowledge graph from repository files
     *
     * @param {string} repoId - "owner/repo"
     * @param {Array<{path: string, content: string}>} files - Repository files
     * @param {Function} onProgress - Progress callback
     * @returns {Object} Build stats
     */
    async buildGraph(repoId, files, onProgress) {
        const startTime = performance.now();

        onProgress?.({ phase: 'graph_symbols', message: 'Extracting code symbols...' });

        // Phase 1: Extract symbols (functions, classes, methods)
        this.graph.clear();
        this.symbolExtractor.extractAll(this.graph, files);

        const symbolStats = this.graph.getStats();
        onProgress?.({
            phase: 'graph_symbols',
            message: `Extracted ${symbolStats.nodeCount} symbols from ${files.length} files`
        });

        // Phase 2–4: Build call graph (imports + calls + heritage)
        onProgress?.({ phase: 'graph_calls', message: 'Resolving function calls and imports...' });

        const callGraphBuilder = new CallGraphBuilder(this.graph, this.symbolExtractor);
        callGraphBuilder.build(files);

        const callStats = this.graph.getStats();
        const callEdges = callStats.relationshipsByType?.CALLS || 0;
        const importEdges = callStats.relationshipsByType?.IMPORTS || 0;
        onProgress?.({
            phase: 'graph_calls',
            message: `Resolved ${callEdges} call edges, ${importEdges} import edges`
        });

        // Phase 5: Community detection
        onProgress?.({ phase: 'graph_communities', message: 'Detecting code communities...' });

        this.communityDetector = new CommunityDetector(this.graph);
        const communityResult = this.communityDetector.detect();

        onProgress?.({
            phase: 'graph_communities',
            message: `Found ${communityResult.stats.totalCommunities} communities (modularity: ${communityResult.stats.modularity})`
        });

        // Phase 6: Process/flow tracing
        onProgress?.({ phase: 'graph_processes', message: 'Detecting execution flows...' });

        this.processTracer = new ProcessTracer(this.graph);
        const processResult = this.processTracer.detect(communityResult.memberships);

        onProgress?.({
            phase: 'graph_processes',
            message: `Detected ${processResult.stats.totalProcesses} execution flows (${processResult.stats.crossCommunityCount} cross-module)`
        });

        // Phase 7: Initialize analyzers
        this.impactAnalyzer = new ImpactAnalyzer(this.graph);

        // Phase 8: Persist to IndexedDB
        onProgress?.({ phase: 'graph_saving', message: 'Saving knowledge graph...' });
        await this.graph.save(repoId);

        const elapsed = Math.round(performance.now() - startTime);
        const finalStats = this.graph.getStats();

        this._lastBuildStats = {
            repoId,
            nodeCount: finalStats.nodeCount,
            relationshipCount: finalStats.relationshipCount,
            nodesByLabel: finalStats.nodesByLabel,
            relationshipsByType: finalStats.relationshipsByType,
            communities: communityResult.stats.totalCommunities,
            processes: processResult.stats.totalProcesses,
            crossCommunityProcesses: processResult.stats.crossCommunityCount,
            modularity: communityResult.stats.modularity,
            buildTimeMs: elapsed
        };

        onProgress?.({
            phase: 'graph_complete',
            message: `Knowledge graph built in ${elapsed}ms: ${finalStats.nodeCount} nodes, ${finalStats.relationshipCount} edges, ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} flows`
        });

        return this._lastBuildStats;
    }

    /**
     * Load a previously built graph from IndexedDB
     */
    async loadGraph(repoId) {
        const result = await this.graph.load(repoId);

        if (result.nodeCount > 0) {
            this.impactAnalyzer = new ImpactAnalyzer(this.graph);
            this.processTracer = new ProcessTracer(this.graph);
            this.communityDetector = new CommunityDetector(this.graph);

            // Rebuild symbol table from loaded graph
            this._rebuildSymbolTable();
        }

        return result;
    }

    /**
     * Check if a graph exists for a repo
     */
    async hasGraph(repoId) {
        return this.graph.hasGraph(repoId);
    }

    /**
     * Delete a repo's graph
     */
    async deleteGraph(repoId) {
        return this.graph.delete(repoId);
    }

    /**
     * Rebuild the symbol table from the loaded graph
     * (needed after loading from IndexedDB since symbol table is in-memory only)
     */
    _rebuildSymbolTable() {
        this.symbolExtractor.symbolTable.clear();
        this.symbolExtractor.globalIndex.clear();

        for (const node of this.graph.nodes.values()) {
            if (node.label === 'File' || node.label === 'Community' || node.label === 'Process') continue;

            const filePath = node.properties?.filePath;
            const name = node.properties?.name;
            if (!filePath || !name) continue;

            if (!this.symbolExtractor.symbolTable.has(filePath)) {
                this.symbolExtractor.symbolTable.set(filePath, new Map());
            }
            this.symbolExtractor.symbolTable.get(filePath).set(name, node.id);

            if (!this.symbolExtractor.globalIndex.has(name)) {
                this.symbolExtractor.globalIndex.set(name, []);
            }
            this.symbolExtractor.globalIndex.get(name).push({
                nodeId: node.id,
                filePath,
                type: node.label
            });
        }
    }

    // --- Query methods for chat context injection ---

    /**
     * Get comprehensive context for a symbol (impact + processes + community)
     * Used to inject rich context into LLM chat prompts.
     *
     * @param {string} symbolName - Function or class name
     * @returns {string|null} Formatted context for prompt injection
     */
    getSymbolContext(symbolName) {
        if (!this.graph || this.graph.nodeCount === 0) return null;

        const sections = [];

        // 360-degree symbol view
        const symbolView = this._getSymbolView(symbolName);
        if (symbolView) sections.push(symbolView);

        // Impact analysis
        if (this.impactAnalyzer) {
            const impact = this.impactAnalyzer.formatForPrompt(symbolName, {
                direction: 'upstream',
                maxDepth: 3,
                minConfidence: 0.3
            });
            if (impact) sections.push(impact);
        }

        // Process/execution flow context
        if (this.processTracer) {
            const processes = this.processTracer.formatForPrompt(symbolName);
            if (processes) sections.push(processes);
        }

        // Community membership
        if (this.communityDetector) {
            const community = this.communityDetector.formatForPrompt(symbolName);
            if (community) sections.push(community);
        }

        if (sections.length === 0) return null;

        return `\n--- Knowledge Graph Context ---\n\n${sections.join('\n\n')}`;
    }

    /**
     * Get 360-degree view of a symbol: callers, callees, imports
     */
    _getSymbolView(symbolName) {
        const nodes = this.graph.findNodeByName(symbolName);
        if (nodes.length === 0) return null;

        const node = nodes[0];
        const outgoing = this.graph.getRelationshipsFrom(node.id).filter(r => r.type === 'CALLS');
        const incoming = this.graph.getRelationshipsTo(node.id).filter(r => r.type === 'CALLS');

        if (outgoing.length === 0 && incoming.length === 0) return null;

        let view = `## Symbol: \`${symbolName}\` [${node.label}]\n`;
        view += `File: ${node.properties?.filePath}:${node.properties?.startLine || '?'}\n`;

        if (incoming.length > 0) {
            view += `\n**Called by** (${incoming.length}):\n`;
            for (const rel of incoming.slice(0, 8)) {
                const caller = this.graph.getNode(rel.sourceId);
                if (caller) {
                    const conf = (rel.confidence * 100).toFixed(0);
                    view += `- \`${caller.properties?.name}\` (${caller.properties?.filePath}) [${conf}%]\n`;
                }
            }
            if (incoming.length > 8) view += `- ... and ${incoming.length - 8} more callers\n`;
        }

        if (outgoing.length > 0) {
            view += `\n**Calls** (${outgoing.length}):\n`;
            for (const rel of outgoing.slice(0, 8)) {
                const callee = this.graph.getNode(rel.targetId);
                if (callee) {
                    view += `- \`${callee.properties?.name}\` (${callee.properties?.filePath})\n`;
                }
            }
            if (outgoing.length > 8) view += `- ... and ${outgoing.length - 8} more callees\n`;
        }

        return view;
    }

    /**
     * Auto-detect symbols mentioned in a user question and return graph context
     * Used for automatic context injection during chat.
     *
     * @param {string} question - User's chat message
     * @param {string} code - Currently viewed code (optional)
     * @returns {string|null} Combined graph context for all detected symbols
     */
    getContextForQuestion(question, code = '') {
        if (!this.graph || this.graph.nodeCount === 0) return null;

        const mentionedSymbols = this._extractSymbolMentions(question, code);
        if (mentionedSymbols.length === 0) {
            // No specific symbols mentioned — return architecture overview
            return this.communityDetector?.formatOverviewForPrompt() || null;
        }

        const contexts = [];
        const seen = new Set();

        for (const symbolName of mentionedSymbols.slice(0, 3)) {
            if (seen.has(symbolName)) continue;
            seen.add(symbolName);

            const ctx = this.getSymbolContext(symbolName);
            if (ctx) contexts.push(ctx);
        }

        return contexts.length > 0 ? contexts.join('\n') : null;
    }

    /**
     * Extract symbol names mentioned in the question or visible in the code
     */
    _extractSymbolMentions(question, code) {
        const mentioned = [];
        const words = question.split(/[\s.,;:!?()`'"{}[\]]+/).filter(w => w.length > 2);

        // Check each word against the global symbol index
        for (const word of words) {
            const matches = this.symbolExtractor.lookupFuzzy(word);
            if (matches.length > 0 && matches.length < 5) {
                mentioned.push(word);
            }
        }

        // Also check for patterns like "function X", "class X", "method X"
        const patterns = [
            /(?:function|method|class|interface)\s+[`'"]?(\w+)[`'"]?/gi,
            /\b(?:change|modify|refactor|rename|update|delete|remove)\s+[`'"]?(\w+)[`'"]?/gi,
            /\b(?:safe to change|impact of|depends on|breaks|break)\s+[`'"]?(\w+)[`'"]?/gi,
            /[`](\w+)[`]/g
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(question)) !== null) {
                const name = match[1];
                if (name && this.symbolExtractor.lookupFuzzy(name).length > 0) {
                    mentioned.push(name);
                }
            }
        }

        // If code is provided and no specific symbols found, extract from code
        if (mentioned.length === 0 && code) {
            const codePatterns = [
                /(?:function|class|const|let|var|def|func)\s+(\w+)/g,
                /export\s+(?:default\s+)?(?:function|class)\s+(\w+)/g
            ];
            for (const pattern of codePatterns) {
                let match;
                while ((match = pattern.exec(code)) !== null) {
                    if (this.symbolExtractor.lookupFuzzy(match[1]).length > 0) {
                        mentioned.push(match[1]);
                    }
                }
            }
        }

        return [...new Set(mentioned)];
    }

    /**
     * Quick safety check for a symbol change
     */
    safetyCheck(symbolName) {
        if (!this.impactAnalyzer) return null;
        return this.impactAnalyzer.quickSafetyCheck(symbolName);
    }

    /**
     * Get graph build stats
     */
    getStats() {
        return this._lastBuildStats || this.graph.getStats();
    }
}

export default CodeGraphPipeline;

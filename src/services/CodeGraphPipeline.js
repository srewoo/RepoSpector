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
import { TestCoverageBuilder } from './TestCoverageBuilder.js';
import { OffscreenGraphParser } from './OffscreenGraphParser.js';
import { PrecomputedAnalysis } from './PrecomputedAnalysis.js';
import { GraphAnalysisCache } from './GraphAnalysisCache.js';
import { hashContent } from './IndexManifest.js';

export class CodeGraphPipeline {
    constructor(opts = {}) {
        this.graph = opts.graph || new KnowledgeGraphService();
        this.symbolExtractor = new SymbolExtractor();
        // Tree-sitter parsing runs in the offscreen document (MV3 SWs can't load
        // the WASM runtime). It's a progressive enhancement: any failure falls
        // back transparently to the regex extraction path.
        this.offscreenParser = opts.offscreenParser || new OffscreenGraphParser();
        // Per-repo cache of file hashes + tree-sitter analyses for incremental rebuilds.
        this.analysisCache = opts.analysisCache || new GraphAnalysisCache();
        this.impactAnalyzer = null;
        this.processTracer = null;
        this.communityDetector = null;
        this.testCoverageBuilder = null;
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
        const parseStart = performance.now();

        // Tree-sitter analysis for ALL files in the offscreen document (best-effort).
        let tsAnalyses = null;
        try {
            const analyses = await this.offscreenParser.analyzeFiles(files);
            if (analyses && analyses.size > 0) tsAnalyses = analyses;
        } catch (_e) {
            tsAnalyses = null;
        }

        return this._assembleAndPersist(repoId, files, tsAnalyses, { startTime, parseStart, onProgress });
    }

    /**
     * Incremental rebuild: re-parse ONLY changed files (the expensive offscreen
     * step), reuse cached analyses for unchanged files, then reassemble the full
     * graph (assembly is cheap and keeps cross-file call resolution correct).
     * Falls back to a full buildGraph when no cache/graph exists yet.
     */
    async updateGraph(repoId, files, onProgress) {
        const startTime = performance.now();
        const parseStart = performance.now();

        const [cache, hasGraph] = await Promise.all([
            this.analysisCache.get(repoId),
            this.graph.hasGraph(repoId).catch(() => false)
        ]);

        if (!cache || !hasGraph) {
            return this.buildGraph(repoId, files, onProgress); // cold start
        }

        const prevHashes = cache.fileHashes || {};
        const prevTs = cache.tsAnalyses || {};
        const changed = files.filter(f => hashContent(f.content) !== prevHashes[f.path]);
        const changedSet = new Set(changed.map(f => f.path));

        onProgress?.({
            phase: 'graph_symbols',
            message: `Incremental: ${changed.length} changed, ${files.length - changed.length} reused`
        });

        // Parse only changed files in the offscreen document.
        let freshTs = null;
        if (changed.length > 0) {
            try { freshTs = await this.offscreenParser.analyzeFiles(changed); } catch (_e) { freshTs = null; }
        }

        // Merge: fresh analyses for changed files, cached analyses for the rest.
        const mergedTs = new Map();
        for (const f of files) {
            if (changedSet.has(f.path)) {
                if (freshTs && freshTs.has(f.path)) mergedTs.set(f.path, freshTs.get(f.path));
            } else if (prevTs[f.path]) {
                mergedTs.set(f.path, prevTs[f.path]);
            }
        }

        const stats = await this._assembleAndPersist(
            repoId, files, mergedTs.size > 0 ? mergedTs : null, { startTime, parseStart, onProgress }
        );
        stats.incremental = {
            changedFiles: changed.length,
            reusedFiles: files.length - changed.length
        };
        return stats;
    }

    /**
     * Assemble the full graph from files + (optional) tree-sitter analyses, run
     * coverage/community/process phases, persist graph + analysis cache, and
     * return build stats. Shared by buildGraph and updateGraph.
     */
    async _assembleAndPersist(repoId, files, tsAnalyses, { startTime, parseStart, onProgress }) {
        const tsAdapter = tsAnalyses ? new PrecomputedAnalysis(tsAnalyses) : null;
        const tsReady = !!tsAnalyses;

        onProgress?.({ phase: 'graph_symbols', message: 'Extracting code symbols...' });

        // Phase 1: Extract symbols (functions, classes, methods)
        this.graph.clear();
        this.symbolExtractor.extractAll(this.graph, files, tsAdapter);

        const symbolStats = this.graph.getStats();
        onProgress?.({
            phase: 'graph_symbols',
            message: `Extracted ${symbolStats.nodeCount} symbols from ${files.length} files` +
                (tsReady ? ' (tree-sitter AST)' : ' (regex)')
        });

        // Phase 2–4: Build call graph (imports + calls + heritage)
        onProgress?.({ phase: 'graph_calls', message: 'Resolving function calls and imports...' });

        const callGraphBuilder = new CallGraphBuilder(this.graph, this.symbolExtractor, tsAdapter);
        callGraphBuilder.build(files);

        const callStats = this.graph.getStats();
        const callEdges = callStats.relationshipsByType?.CALLS || 0;
        const importEdges = callStats.relationshipsByType?.IMPORTS || 0;
        onProgress?.({
            phase: 'graph_calls',
            message: `Resolved ${callEdges} call edges, ${importEdges} import edges`
        });

        // Phase 4b: Test coverage edges (TESTED_BY) — which symbols are exercised by tests
        onProgress?.({ phase: 'graph_coverage', message: 'Mapping test coverage...' });
        this.testCoverageBuilder = new TestCoverageBuilder(this.graph);
        const coverageStats = this.testCoverageBuilder.build();
        onProgress?.({
            phase: 'graph_coverage',
            message: `Test coverage: ${coverageStats.testedSymbols}/${coverageStats.coverableSymbols} symbols ` +
                `(${Math.round(coverageStats.coverageRatio * 100)}%), ${coverageStats.untestedSymbols} untested`
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

        // Phase 8: Persist to IndexedDB (graph + incremental analysis cache)
        onProgress?.({ phase: 'graph_saving', message: 'Saving knowledge graph...' });
        await this.graph.save(repoId);

        const fileHashes = {};
        for (const f of files) fileHashes[f.path] = hashContent(f.content);
        const tsCacheObj = {};
        if (tsAdapter) {
            for (const [path, analysis] of tsAdapter.analyses) tsCacheObj[path] = analysis;
        }
        await this.analysisCache.set(repoId, { fileHashes, tsAnalyses: tsCacheObj });

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
            buildTimeMs: elapsed,
            parserEngine: tsReady ? 'tree-sitter' : 'regex',
            parseTimeMs: Math.round(performance.now() - parseStart),
            coverage: coverageStats
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
        await this.analysisCache.delete(repoId).catch(() => {});
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
     * Untested symbols in the blast radius of a change — the primary signal for
     * prioritising test generation (RepoSpector's core job). Backed by TESTED_BY
     * edges; works after both buildGraph and loadGraph (isTested is persisted).
     */
    getUntestedInBlastRadius(symbolName, options = {}) {
        if (!this.impactAnalyzer) return null;
        return this.impactAnalyzer.findUntestedInBlastRadius(symbolName, options);
    }

    /**
     * Get graph build stats
     */
    getStats() {
        return this._lastBuildStats || this.graph.getStats();
    }
}

export default CodeGraphPipeline;

/**
 * Build the code graph for a corpus case, in-process, from `fileContents`.
 *
 * This is the piece the harness never had. `reviewContextBudget.js` used to
 * record that graph CONTEXT was inert here because nothing supplied a graph;
 * this module supplies one, so graph FINDINGS (not the retrieval prompt
 * context — see that file's header) are measurable per case. The graph below
 * is REGEX-built (no tree-sitter in Node) and covers only the files the
 * corpus carries, so it UNDERSTATES production: a caller in a file the PR did
 * not touch is invisible unless `fetch-content.js` fetched it. That is the
 * safe direction, and it is recorded per case in `stats`.
 */
import { KnowledgeGraphService } from '../../src/services/KnowledgeGraphService.js';
import { SymbolExtractor } from '../../src/services/SymbolExtractor.js';
import { CallGraphBuilder } from '../../src/services/CallGraphBuilder.js';
import { TestCoverageBuilder } from '../../src/services/TestCoverageBuilder.js';
import { ImpactAnalyzer } from '../../src/services/ImpactAnalyzer.js';
import { GraphImpactFindingsService } from '../../src/services/GraphImpactFindingsService.js';

export function buildGraphFromCase(kase) {
    const contents = kase?.fileContents || {};
    const files = Object.entries(contents)
        .filter(([, c]) => typeof c === 'string' && c.length > 0)
        .map(([path, content]) => ({ path, content }));
    if (!files.length) {
        return { available: false, graph: null, impactAnalyzer: null, stats: { files: 0, nodes: 0, callEdges: 0, testedSymbols: 0 } };
    }

    const graph = new KnowledgeGraphService();
    const extractor = new SymbolExtractor();
    extractor.extractAll(graph, files, null);
    new CallGraphBuilder(graph, extractor, null).build(files);
    const coverage = new TestCoverageBuilder(graph).build();
    const s = graph.getStats();

    return {
        available: true,
        graph,
        impactAnalyzer: new ImpactAnalyzer(graph),
        stats: {
            files: files.length,
            nodes: s.nodeCount || 0,
            callEdges: s.relationshipsByType?.CALLS || 0,
            testedSymbols: coverage?.testedSymbols || 0,
        },
    };
}

export function graphFindingsForCase(kase, opts = {}) {
    const built = buildGraphFromCase(kase);
    if (!built.available) return { findings: [], stats: { ...built.stats, symbols: 0 } };
    const svc = new GraphImpactFindingsService({ graph: built.graph, impactAnalyzer: built.impactAnalyzer });
    const { findings, stats } = svc.build(kase.prData, opts);
    return { findings, stats: { ...built.stats, ...stats } };
}

export default { buildGraphFromCase, graphFindingsForCase };

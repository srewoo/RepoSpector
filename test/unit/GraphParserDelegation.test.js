/**
 * Verifies that SymbolExtractor and CallGraphBuilder delegate to the tree-sitter
 * analysis (via the PrecomputedAnalysis adapter) when one is supplied for a file,
 * and fall back to the regex path otherwise. The real WASM parser is validated
 * separately/empirically by scripts/ts-probe.mjs across all 12 languages.
 */
const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { SymbolExtractor } = require('../../src/services/SymbolExtractor.js');
const { CallGraphBuilder } = require('../../src/services/CallGraphBuilder.js');
const { PrecomputedAnalysis } = require('../../src/services/PrecomputedAnalysis.js');

describe('SymbolExtractor tree-sitter delegation', () => {
    it('should use analysis symbols when the adapter is ready for the file', () => {
        const graph = new KnowledgeGraphService();
        const extractor = new SymbolExtractor();
        // A symbol name that the regex path could never derive from this content.
        const adapter = new PrecomputedAnalysis(new Map([
            ['src/a.js', { symbols: [{ name: 'astOnlySymbol', label: 'Function', startLine: 1, endLine: 2, isExported: true }], imports: [], calls: [], heritage: [] }]
        ]));

        extractor.extractAll(graph, [{ path: 'src/a.js', content: 'const x = 1;' }], adapter);

        expect(graph.findNodeByName('astOnlySymbol').length).toBe(1);
    });

    it('should fall back to regex extraction when no adapter is given', () => {
        const graph = new KnowledgeGraphService();
        const extractor = new SymbolExtractor();

        extractor.extractAll(graph, [{ path: 'src/a.js', content: 'export function realFn() { return 1; }' }]);

        expect(graph.findNodeByName('realFn').length).toBe(1);
    });

    it('should fall back to regex when the adapter is not ready for that file', () => {
        const graph = new KnowledgeGraphService();
        const extractor = new SymbolExtractor();
        const adapter = new PrecomputedAnalysis(new Map()); // ready for nothing

        extractor.extractAll(graph, [{ path: 'src/a.js', content: 'export function regexFn() {}' }], adapter);

        expect(graph.findNodeByName('regexFn').length).toBe(1);
    });
});

describe('CallGraphBuilder tree-sitter delegation', () => {
    function setup(adapter) {
        const graph = new KnowledgeGraphService();
        const extractor = new SymbolExtractor();
        const files = [
            { path: 'src/util.js', content: 'export function helper() {}' },
            { path: 'src/main.js', content: 'export function run() {}' }
        ];
        extractor.extractAll(graph, files, adapter);
        const builder = new CallGraphBuilder(graph, extractor, adapter);
        builder.build(files);
        return graph;
    }

    it('should create CALLS edges from analysis-provided calls', () => {
        const adapter = new PrecomputedAnalysis(new Map([
            ['src/util.js', { symbols: [{ name: 'helper', label: 'Function', startLine: 1, endLine: 1, isExported: true }], imports: [], calls: [], heritage: [] }],
            ['src/main.js', {
                symbols: [{ name: 'run', label: 'Function', startLine: 1, endLine: 1, isExported: true }],
                imports: [{ source: './util.js' }],
                calls: [{ name: 'helper', line: 1 }],
                heritage: []
            }]
        ]));

        const graph = setup(adapter);
        const callEdges = graph.getRelationshipsByType('CALLS');
        const importEdges = graph.getRelationshipsByType('IMPORTS');

        expect(importEdges.length).toBeGreaterThan(0);
        expect(callEdges.some(e => e.reason === 'import-resolved' || e.reason === 'same-file' || e.reason === 'fuzzy-global')).toBe(true);
    });
});

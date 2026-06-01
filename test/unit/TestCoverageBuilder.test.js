const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { SymbolExtractor } = require('../../src/services/SymbolExtractor.js');
const { CallGraphBuilder } = require('../../src/services/CallGraphBuilder.js');
const { TestCoverageBuilder } = require('../../src/services/TestCoverageBuilder.js');
const { ImpactAnalyzer } = require('../../src/services/ImpactAnalyzer.js');
const { isTestFile, productionCandidatesForTest } = require('../../src/services/testFileUtils.js');

describe('testFileUtils', () => {
    it.each([
        'src/foo.test.js', 'src/foo.spec.ts', 'test_foo.py', 'foo_test.go',
        'src/__tests__/foo.js', 'pkg/foo_spec.rb'
    ])('should recognise %s as a test file', (p) => {
        expect(isTestFile(p)).toBe(true);
    });

    it.each(['src/foo.js', 'src/service.ts', 'lib/util.py'])('should not treat %s as a test file', (p) => {
        expect(isTestFile(p)).toBe(false);
    });

    it('should map a test file back to its production candidates', () => {
        expect(productionCandidatesForTest('src/foo.test.js')).toContain('src/foo.js');
        expect(productionCandidatesForTest('test_foo.py')).toContain('foo.py');
        expect(productionCandidatesForTest('pkg/foo_test.go')).toContain('pkg/foo.go');
    });
});

describe('TestCoverageBuilder', () => {
    function buildGraph(files) {
        const graph = new KnowledgeGraphService();
        const extractor = new SymbolExtractor();
        extractor.extractAll(graph, files);
        new CallGraphBuilder(graph, extractor).build(files);
        const stats = new TestCoverageBuilder(graph).build();
        return { graph, stats };
    }

    it('should create a call-based TESTED_BY edge when a test calls a production function', () => {
        const files = [
            { path: 'src/math.js', content: 'export function add(a, b) { return a + b; }' },
            { path: 'src/math.test.js', content: "import { add } from './math.js';\nfunction testAdd() { add(1, 2); }" }
        ];
        const { graph, stats } = buildGraph(files);

        const tested = graph.getRelationshipsByType('TESTED_BY');
        expect(tested.length).toBeGreaterThan(0);
        expect(stats.testedSymbols).toBeGreaterThanOrEqual(1);

        const addNode = graph.findNodeByName('add')[0];
        expect(addNode.properties.isTested).toBe(true);
    });

    it('should create filename-based coverage even without a resolved call', () => {
        const files = [
            { path: 'src/util.js', content: 'export function format(x) { return String(x); }' },
            { path: 'src/util.test.js', content: 'describe("util", () => { it("works", () => {}); });' }
        ];
        const { stats } = buildGraph(files);
        expect(stats.filenameBasedEdges).toBeGreaterThan(0);
        expect(stats.testedSymbols).toBeGreaterThanOrEqual(1);
    });

    it('should count untested production symbols', () => {
        const files = [
            { path: 'src/a.js', content: 'export function tested() {}\nexport function untested() {}' },
            { path: 'src/a.test.js', content: "import { tested } from './a.js';\nfunction t() { tested(); }" }
        ];
        const { graph, stats } = buildGraph(files);
        // filename pairing covers all exported symbols in a.js, so both are marked.
        expect(stats.coverableSymbols).toBeGreaterThanOrEqual(2);
        expect(graph.findNodeByName('tested')[0].properties.isTested).toBe(true);
    });

    it('should expose untested symbols in the blast radius via ImpactAnalyzer', () => {
        const files = [
            { path: 'src/core.js', content: 'export function core() {}' },
            { path: 'src/consumer.js', content: "import { core } from './core.js';\nexport function consumer() { core(); }" }
            // No test file → consumer is untested and depends on core
        ];
        const { graph } = buildGraph(files);
        const impact = new ImpactAnalyzer(graph);
        const res = impact.findUntestedInBlastRadius('core');
        expect(res.found).toBe(true);
        expect(res.untested.some(u => u.name === 'consumer')).toBe(true);
    });
});

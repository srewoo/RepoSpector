/**
 * TestCoverageBuilder for RepoSpector
 *
 * Models test coverage as graph edges (TESTED_BY: production symbol → test symbol).
 * RepoSpector's whole purpose is test generation, so "which functions in the blast
 * radius of this change have no test" is a first-class question — and that needs
 * coverage in the graph, not just file-name guessing at prompt time.
 *
 * Two signals, run after CALLS edges exist:
 *   1. Call-based (high confidence): a CALLS edge whose caller lives in a test file
 *      and whose target lives in a production file → that target is tested.
 *   2. Filename-based (medium confidence): foo.test.js ↔ foo.js etc. — every exported
 *      symbol in the matched production file is considered covered by that test file.
 *
 * Tested symbols get node.properties.isTested = true so ImpactAnalyzer can flag
 * untested symbols inside a change's blast radius without re-querying.
 *
 * TESTED_BY is intentionally inert to existing consumers: community detection and
 * process tracing only walk CALLS/EXTENDS/IMPLEMENTS, so coverage edges never
 * distort clusters or flows.
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';
import { isTestFile, productionCandidatesForTest } from './testFileUtils.js';

const COVERABLE_LABELS = new Set(['Function', 'Method', 'Class']);

export class TestCoverageBuilder {
    /** @param {import('./KnowledgeGraphService.js').KnowledgeGraphService} graph */
    constructor(graph) {
        this.graph = graph;
    }

    /** Build TESTED_BY edges and return coverage stats. */
    build() {
        const added = new Set(); // dedupe edge ids
        let callBased = 0;
        let fileBased = 0;

        callBased = this._buildCallBased(added);
        fileBased = this._buildFilenameBased(added);

        return this._stats(callBased, fileBased);
    }

    /** Signal 1: CALLS from a test-file caller to a production-file target. */
    _buildCallBased(added) {
        let count = 0;
        for (const rel of this.graph.relationships.values()) {
            if (rel.type !== 'CALLS') continue;
            const caller = this.graph.getNode(rel.sourceId);
            const target = this.graph.getNode(rel.targetId);
            if (!caller || !target) continue;

            const callerFile = caller.properties?.filePath || '';
            const targetFile = target.properties?.filePath || '';
            if (!isTestFile(callerFile) || isTestFile(targetFile)) continue;
            if (!COVERABLE_LABELS.has(target.label)) continue;

            if (this._addTestedBy(target.id, caller.id, rel.confidence ?? 0.8, 'call-in-test', added)) {
                count++;
            }
        }
        return count;
    }

    /** Signal 2: filename pairing (foo.test.js ↔ foo.js). */
    _buildFilenameBased(added) {
        const fileNodesByPath = new Map();
        for (const node of this.graph.getNodesByLabel('File')) {
            if (node.properties?.filePath) fileNodesByPath.set(node.properties.filePath, node);
        }

        let count = 0;
        for (const [path, testFileNode] of fileNodesByPath) {
            if (!isTestFile(path)) continue;
            const prodPath = productionCandidatesForTest(path).find(p => fileNodesByPath.has(p));
            if (!prodPath) continue;

            for (const symbol of this.graph.getNodesByFile(prodPath)) {
                if (!COVERABLE_LABELS.has(symbol.label)) continue;
                if (!symbol.properties?.isExported) continue;
                if (this._addTestedBy(symbol.id, testFileNode.id, 0.5, 'filename-pair', added)) {
                    count++;
                }
            }
        }
        return count;
    }

    _addTestedBy(symbolId, testNodeId, confidence, reason, added) {
        const relId = KnowledgeGraphService.generateId('TESTED_BY', `${symbolId}->${testNodeId}`);
        if (added.has(relId)) return false;
        added.add(relId);

        this.graph.addRelationship({
            id: relId,
            sourceId: symbolId,
            targetId: testNodeId,
            type: 'TESTED_BY',
            confidence,
            reason
        });

        const node = this.graph.getNode(symbolId);
        if (node?.properties) node.properties.isTested = true;
        return true;
    }

    _stats(callBased, fileBased) {
        let coverable = 0;
        let tested = 0;
        for (const node of this.graph.nodes.values()) {
            if (!COVERABLE_LABELS.has(node.label)) continue;
            if (isTestFile(node.properties?.filePath || '')) continue;
            coverable++;
            if (node.properties?.isTested) tested++;
        }
        return {
            testedByEdges: callBased + fileBased,
            callBasedEdges: callBased,
            filenameBasedEdges: fileBased,
            coverableSymbols: coverable,
            testedSymbols: tested,
            untestedSymbols: coverable - tested,
            coverageRatio: coverable === 0 ? 0 : Math.round((tested / coverable) * 1000) / 1000
        };
    }
}

export default TestCoverageBuilder;

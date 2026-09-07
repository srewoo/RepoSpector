/**
 * graphQueries — small, pure reads over a KnowledgeGraphService.
 *
 * Shared by the graph-findings rules (review) and PR test generation, which
 * ask the same question — "who calls this symbol, and from where?" — for two
 * different purposes. One implementation so the answers cannot drift.
 */
import { isTestFile } from '../services/testFileUtils.js';

/** First node named `symbol`, preferring one declared in `preferFile`. */
export function findSymbolNode(graph, symbol, preferFile = null) {
    try {
        const nodes = graph?.findNodeByName?.(symbol) || [];
        if (!nodes.length) return null;
        if (preferFile) {
            const local = nodes.find(n => n?.properties?.filePath === preferFile);
            if (local) return local;
        }
        return nodes[0];
    } catch {
        return null;
    }
}

/**
 * Distinct callers of every node named `symbol`.
 * @returns {Array<{name:string, filePath:string, line:number|null, confidence:number}>}
 */
export function listCallers(graph, symbol, opts = {}) {
    const { excludeFiles = new Set(), excludeTests = true, limit = 20 } = opts;
    const out = [];
    const seen = new Set();
    try {
        for (const node of graph?.findNodeByName?.(symbol) || []) {
            for (const rel of graph.getRelationshipsTo(node.id) || []) {
                if (rel.type !== 'CALLS') continue;
                const caller = graph.getNode(rel.sourceId);
                const filePath = caller?.properties?.filePath;
                if (!filePath || excludeFiles.has(filePath)) continue;
                if (excludeTests && isTestFile(filePath)) continue;
                const key = `${filePath}:${caller.properties.startLine ?? ''}:${caller.properties.name}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    name: caller.properties.name,
                    filePath,
                    line: caller.properties.startLine ?? null,
                    confidence: rel.confidence ?? 0.5,
                });
                if (out.length >= limit) return out;
            }
        }
    } catch {
        return out;
    }
    return out;
}

export default { findSymbolNode, listCallers };

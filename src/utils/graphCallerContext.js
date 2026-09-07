import { extractDeclaredSymbols } from './declaredSymbols.js';
import { listCallers } from './graphQueries.js';

/**
 * Collects real call sites from the code graph for symbols declared in `code`,
 * so a test-generation prompt can show the model how production code actually
 * calls the functions under test.
 *
 * `repoId` is required even when a graph is already resident in memory:
 * `CodeGraphPipeline` holds a single shared `this.graph` instance with no
 * record of which repository it currently holds, so reading it without a
 * `repoId` to gate on can silently return another repository's call sites
 * attached to this prompt as if they were verified facts about this repo.
 *
 * Never throws — returns `[]` on any missing input or internal error.
 */
export async function collectGraphCallers({ pipeline, repoId, code, maxSymbols = 3, callersPerSymbol = 3 }) {
    if (!pipeline || !repoId || !code) {
        return [];
    }

    try {
        if (!pipeline.hasGraphFor(repoId) && await pipeline.hasGraph(repoId)) {
            await pipeline.loadGraph(repoId);
        }

        if (pipeline.hasGraphFor(repoId)) {
            const symbols = extractDeclaredSymbols(code).slice(0, maxSymbols);
            return symbols
                .map(symbol => ({ symbol, callers: listCallers(pipeline.graph, symbol, { limit: callersPerSymbol }) }))
                .filter(g => g.callers.length);
        }
    } catch (_e) {
        return [];
    }

    return [];
}

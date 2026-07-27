/**
 * CrossRepoImpactService — FOUNDATION for cross-repo impact analysis.
 *
 * RepoSpector is single-repo today: every graph/index is keyed to one repoId and
 * the call graph never crosses repo boundaries. This service is the first
 * primitive toward "a change in repo A impacts repo B": given the symbols a PR
 * changed and a declared set of linked repos (from `.repospector.yaml` workspace),
 * it checks each linked repo's stored graph for references to those symbols, and —
 * when auto-index is enabled — indexes a linked repo on demand before checking it.
 *
 * Everything is dependency-injected (isRepoIndexed / loadGraph / indexRepo), so the
 * resolution logic is unit-testable without IndexedDB or the network. Wiring it into
 * the live review path is a follow-up (see docs/design/cross-repo-impact.md) — it is
 * NOT active in a review yet, because populating cross-repo references requires each
 * linked repo to be indexed first, which is exactly the auto-index step below.
 */

// Heuristic extraction of the exported/public symbols a diff changed. A real
// implementation would use the tree-sitter symbol table; this covers the common
// declaration forms across JS/TS/Python/Go and is good enough to seed impact.
const DECL_PATTERNS = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /export\s+const\s+([A-Za-z_$][\w$]*)/,
    /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Z][\w]*)/,   // Go exported func (Capitalized)
    /(?:^|\s)def\s+([A-Za-z_][\w]*)/,                  // Python def
    /(?:^|\s)class\s+([A-Za-z_][\w]*)/                 // Python/JS class
];

export class CrossRepoImpactService {
    /**
     * @param {Object} deps
     * @param {(repoId:string)=>Promise<boolean>} deps.isRepoIndexed
     * @param {(repoId:string)=>Promise<Object|null>} deps.loadGraph - graph exposes
     *        findReferences(symbol) -> [{file}] (or referencesSymbol(symbol) -> boolean)
     * @param {(url:string)=>Promise<void>} [deps.indexRepo] - index a repo on demand
     */
    constructor({ isRepoIndexed, loadGraph, indexRepo } = {}) {
        this.isRepoIndexed = isRepoIndexed;
        this.loadGraph = loadGraph;
        this.indexRepo = indexRepo;
    }

    /**
     * Extract changed exported/public symbol names from a PR's added lines.
     * @param {Object} prData
     * @returns {string[]} unique symbol names
     */
    static extractChangedSymbols(prData) {
        const names = new Set();
        for (const f of (prData?.files || [])) {
            const added = String(f.patch || '')
                .split('\n')
                .filter(l => l.startsWith('+') && !l.startsWith('+++'))
                .map(l => l.slice(1));
            for (const line of added) {
                for (const re of DECL_PATTERNS) {
                    const m = line.match(re);
                    if (m && m[1]) names.add(m[1]);
                }
            }
        }
        return [...names];
    }

    /**
     * @param {Object} opts
     * @param {string[]} opts.changedSymbols
     * @param {Array<{url:string, repoId:string|null, role:string}>} opts.linkedRepos
     * @param {boolean} [opts.autoIndex=false]
     * @param {Function} [opts.onProgress]
     * @returns {Promise<{ dependents:Array, needsIndexing:Array, indexedNow:string[] }>}
     */
    async analyze({ changedSymbols = [], linkedRepos = [], autoIndex = false, onProgress = null } = {}) {
        const dependents = [];
        const needsIndexing = [];
        const indexedNow = [];

        if (!changedSymbols.length || !linkedRepos.length) {
            return { dependents, needsIndexing, indexedNow };
        }

        for (const repo of linkedRepos) {
            if (!repo.repoId) { needsIndexing.push(repo); continue; }
            onProgress?.({ phase: 'cross-repo', message: `Checking ${repo.repoId}...` });

            let indexed = this.isRepoIndexed ? await this.isRepoIndexed(repo.repoId) : false;

            // Auto-index-on-impact: index a linked repo on demand before checking it.
            if (!indexed) {
                if (autoIndex && this.indexRepo) {
                    try {
                        await this.indexRepo(repo.url);
                        indexed = true;
                        indexedNow.push(repo.repoId);
                    } catch (e) {
                        needsIndexing.push({ ...repo, error: e?.message });
                        continue;
                    }
                } else {
                    needsIndexing.push(repo);
                    continue;
                }
            }

            const graph = this.loadGraph ? await this.loadGraph(repo.repoId) : null;
            if (!graph) { needsIndexing.push(repo); continue; }

            const hits = [];
            for (const symbol of changedSymbols) {
                const refs = this._refs(graph, symbol);
                if (refs.length) hits.push({ symbol, files: refs.map(r => r.file).filter(Boolean) });
            }
            if (hits.length) {
                dependents.push({ repoId: repo.repoId, url: repo.url, role: repo.role, hits });
            }
        }

        return { dependents, needsIndexing, indexedNow };
    }

    _refs(graph, symbol) {
        if (typeof graph.findReferences === 'function') {
            return graph.findReferences(symbol) || [];
        }
        if (typeof graph.referencesSymbol === 'function') {
            return graph.referencesSymbol(symbol) ? [{ file: null }] : [];
        }
        return [];
    }
}

export default CrossRepoImpactService;

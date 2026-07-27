import { KnowledgeGraphService } from './KnowledgeGraphService.js';
import { CrossRepoImpactService } from './CrossRepoImpactService.js';
import { linkedRepos, parseWorkspace } from '../utils/workspaceConfig.js';

/**
 * ReviewCrossRepoService — P1/P2 wiring for cross-repo impact.
 *
 * Bridges the pure CrossRepoImpactService resolver to the real graph store: it loads
 * each linked repo's persisted knowledge graph into an ISOLATED KnowledgeGraphService
 * instance (so it never clobbers the current review's in-memory graph) and queries it
 * with the new findReferences() primitive. Auto-index is delegated to an injected
 * indexRepo (wired to the existing indexing routine by the caller).
 *
 * Only runs when a `.repospector.yaml` `workspace.repos` block is present — zero cost
 * otherwise. Best-effort: any failure returns null and the review proceeds.
 *
 * DI-friendly: isRepoIndexed / loadGraph can be overridden for tests without
 * IndexedDB.
 */
export class ReviewCrossRepoService {
    /**
     * @param {Object} deps
     * @param {(url:string)=>Promise<void>} [deps.indexRepo] - auto-index a repo on demand
     * @param {(repoId:string)=>Promise<boolean>} [deps.isRepoIndexed]
     * @param {(repoId:string)=>Promise<Object|null>} [deps.loadGraph]
     */
    constructor({ indexRepo, isRepoIndexed, loadGraph } = {}) {
        this.indexRepo = indexRepo;
        this._graphCache = new Map();
        this._stats = ReviewCrossRepoService.emptyStats();
        this._isRepoIndexed = isRepoIndexed || ((repoId) => this._defaultIsIndexed(repoId));
        this._loadGraph = loadGraph || ((repoId) => this._defaultLoadGraph(repoId));
    }

    /**
     * Observability counters — see docs/design/cross-repo-impact.md.
     *
     * This whole feature is best-effort and try/catch'd at every level, so a silent
     * zero is indistinguishable from a correct zero. These counters are the only way
     * to tell "found nothing" from "broke and returned nothing". Two of them are
     * unambiguous defects rather than outcomes: `graphsEmpty > 0` and
     * `symbolsExtracted === 0` on an MR that changed code.
     */
    static emptyStats() {
        return {
            workspaceDeclared: false,
            linkedReposConfigured: 0,
            linkedReposChecked: 0,
            linkedReposSkipped: 0,
            graphsEmpty: 0,
            loadFailures: 0,
            symbolsExtracted: 0,
            referencesFound: 0,
            dependentRepos: 0,
            durationMs: 0,
        };
    }

    async _defaultIsIndexed(repoId) {
        try {
            const g = new KnowledgeGraphService();
            await g.init();
            return await g.hasGraph(repoId);
        } catch { return false; }
    }

    /**
     * Empty-graph gate applied to EVERY loaded graph, whichever loader produced it.
     *
     * A graph that loads with zero nodes is always a defect — wrong repoId key, a
     * failed index, a cleared store — but it answers "no references", which is
     * byte-identical to a correct negative. This is the single most likely way for
     * cross-repo impact to be quietly dead in production.
     *
     * It lives here, not inside `_defaultLoadGraph`, so an injected loader is held
     * to the same standard; otherwise the counter would only work in the one code
     * path nobody runs in tests.
     *
     * @returns {object|null} the graph, or null when unusable
     */
    _gateGraph(repoId, graph) {
        if (!graph) return null;

        // Only reject a graph we can POSITIVELY determine is empty. A graph object
        // that exposes no size at all (a custom store, a test double) is passed
        // through — rejecting the unmeasurable would turn this safety net into the
        // very silent-failure it exists to prevent.
        const nodeCount = typeof graph.nodeCount === 'number'
            ? graph.nodeCount
            : (graph.nodes instanceof Map || Array.isArray(graph.nodes))
                ? (graph.nodes.size ?? graph.nodes.length)
                : null;

        if (nodeCount === 0) {
            this._stats.graphsEmpty++;
            console.warn(`Cross-repo: graph for ${repoId} loaded but is EMPTY — treated as unavailable`);
            return null;
        }
        return graph;
    }

    async _defaultLoadGraph(repoId) {
        if (this._graphCache.has(repoId)) return this._graphCache.get(repoId);
        try {
            const g = new KnowledgeGraphService();
            await g.init();
            await g.load(repoId);
            this._graphCache.set(repoId, g);
            return g;
        } catch (e) {
            this._stats.loadFailures++;
            console.warn(`Cross-repo: failed to load graph for ${repoId}:`, e?.message);
            this._graphCache.set(repoId, null);
            return null;
        }
    }

    /**
     * @param {Object} opts - { prData, customConfig, currentRepoId, onProgress }
     * @returns {Promise<null | { dependents:Array, needsIndexing:Array, indexedNow:string[], changedSymbols:string[] }>}
     */
    async run({ prData, customConfig, currentRepoId, onProgress = null } = {}) {
        const startedAt = Date.now();
        this._stats = ReviewCrossRepoService.emptyStats();

        const links = linkedRepos(customConfig || {}, currentRepoId);
        if (!links.length) return null; // no workspace declared → skip entirely

        this._stats.workspaceDeclared = true;
        this._stats.linkedReposConfigured = links.length;

        const { autoIndex } = parseWorkspace(customConfig || {});
        const changedSymbols = CrossRepoImpactService.extractChangedSymbols(prData);
        this._stats.symbolsExtracted = changedSymbols.length;

        if (!changedSymbols.length) {
            // Zero symbols on an MR that changed code means the regex extractor
            // failed, not that the MR is symbol-free. Say so rather than reporting
            // a clean "no impact".
            const changedCode = (prData?.files || []).some(f => (f.patch || '').includes('\n+'));
            if (changedCode) {
                console.warn('Cross-repo: extracted 0 changed symbols from an MR that changed code — '
                    + 'the declaration regexes likely missed this syntax (see design doc, P3)');
            }
            this._stats.durationMs = Date.now() - startedAt;
            return { dependents: [], needsIndexing: [], indexedNow: [], changedSymbols, stats: { ...this._stats } };
        }

        const resolver = new CrossRepoImpactService({
            isRepoIndexed: this._isRepoIndexed,
            // Every graph — however it was loaded — passes the empty-graph gate.
            loadGraph: async (repoId) => this._gateGraph(repoId, await this._loadGraph(repoId)),
            indexRepo: this.indexRepo
        });

        onProgress?.({ phase: 'cross-repo', message: `Checking ${links.length} linked repo(s) for impact...` });
        const res = await resolver.analyze({ changedSymbols, linkedRepos: links, autoIndex, onProgress });

        this._stats.dependentRepos = res.dependents?.length || 0;
        this._stats.referencesFound = (res.dependents || [])
            .reduce((sum, d) => sum + (d.hits || []).reduce((s, h) => s + (h.files?.length || 1), 0), 0);
        this._stats.linkedReposSkipped = res.needsIndexing?.length || 0;
        this._stats.linkedReposChecked = links.length - this._stats.linkedReposSkipped;
        this._stats.durationMs = Date.now() - startedAt;

        console.log(`🔗 Cross-repo: ${this._stats.linkedReposChecked}/${links.length} repo(s) checked, `
            + `${this._stats.symbolsExtracted} symbol(s), ${this._stats.dependentRepos} dependent repo(s)`
            + `${this._stats.graphsEmpty ? `, ⚠️ ${this._stats.graphsEmpty} EMPTY graph(s)` : ''}`);

        return { ...res, changedSymbols, stats: { ...this._stats } };
    }

    /**
     * Render a short markdown "Cross-repo impact" section for the review output.
     * @param {Object} report - the object returned by run()
     * @returns {string}
     */
    static renderSection(report) {
        if (!report || !report.dependents?.length) return '';
        const lines = ['## Cross-Repo Impact', '', `Changed symbols also referenced by linked repos:`];
        for (const dep of report.dependents) {
            const symbols = dep.hits.map(h => h.symbol).join(', ');
            const files = [...new Set(dep.hits.flatMap(h => h.files).filter(Boolean))].slice(0, 5);
            lines.push(`- **${dep.repoId}** (${dep.role}) uses \`${symbols}\`${files.length ? ` — e.g. ${files.join(', ')}` : ''}`);
        }
        if (report.indexedNow?.length) lines.push('', `_Auto-indexed on demand: ${report.indexedNow.join(', ')}_`);
        if (report.needsIndexing?.length) {
            lines.push('', `_Not checked (not indexed; enable \`workspace.autoIndex\`): ${report.needsIndexing.map(r => r.repoId || r.url).join(', ')}_`);
        }
        return lines.join('\n');
    }

    /**
     * Promote cross-repo impact into actual FINDINGS, not just narrative.
     *
     * A markdown section at the bottom of the summary is read by nobody. Bastion
     * emits these as `code_feedback` entries tagged
     * `rule: "cross-repo-coupling:<consumer_repo>"` precisely so they land in the
     * reviewer's face — "you changed this proto and service X still reads the old
     * field" is the single highest-value finding a multi-repo reviewer can
     * produce, and no single-repo tool can produce it at all.
     *
     * Severity is gated on whether the change is actually BREAKING, which is what
     * separates a useful finding from noise:
     *
     *   blocking   — the symbol was REMOVED or RENAMED, or its SIGNATURE changed,
     *                and a linked repo still references it. That consumer breaks.
     *   suggestion — the symbol is merely referenced elsewhere. Worth knowing
     *                before merging; not a defect on its own.
     *
     * @param {Object} report - the object returned by run()
     * @param {Object} [brief] - MR brief from MRChunker.buildBrief; supplies
     *        removed_exports / changed_signatures. Absent → everything is a
     *        suggestion, since we cannot prove a break.
     * @returns {Array<Object>} canonical-ish findings for toCanonicalFinding
     */
    static toFindings(report, brief = null) {
        if (!report?.dependents?.length) return [];

        // `removed_exports` / `changed_signatures` are "path::symbol" strings.
        // We only need the symbol half — the consumer breaks regardless of which
        // file in this repo used to export it.
        const symbolOf = (entry) => String(entry).split('::').pop();
        const breaking = new Set([
            ...(brief?.removed_exports || []).map(symbolOf),
            ...(brief?.changed_signatures || []).map(symbolOf),
        ]);
        // A rename removes the old name from the consumer's point of view.
        const renamed = (brief?.rename_pairs || []).length > 0;

        const findings = [];
        for (const dep of report.dependents) {
            for (const hit of dep.hits || []) {
                const isBreaking = breaking.has(hit.symbol);
                const files = (hit.files || []).filter(Boolean).slice(0, 5);

                findings.push({
                    severity: isBreaking ? 'blocking' : 'suggestion',
                    category: 'architecture',
                    phase: 'deep',
                    source: 'cross-repo',
                    // Tag mirrors Bastion's so downstream dedupe can recognise
                    // these as load-bearing and never collapse them.
                    rule: `cross-repo-coupling:${dep.repoId}`,
                    // Deliberately unanchored: the defect is in ANOTHER repo, so
                    // there is no line in this diff to attach it to. The posting
                    // policy lifts unanchored findings into the summary, which is
                    // the correct destination for them.
                    file: null,
                    line: null,
                    title: isBreaking
                        ? `Breaking change to \`${hit.symbol}\` — still used by ${dep.repoId}`
                        : `\`${hit.symbol}\` is also used by ${dep.repoId}`,
                    message: isBreaking
                        ? `\`${hit.symbol}\` was removed, renamed or had its signature changed in this PR, `
                          + `but \`${dep.repoId}\` (${dep.role}) still references it`
                          + `${files.length ? ` in ${files.join(', ')}` : ''}. `
                          + 'That consumer will break unless it is updated in lockstep.'
                        : `\`${dep.repoId}\` (${dep.role}) references \`${hit.symbol}\``
                          + `${files.length ? ` in ${files.join(', ')}` : ''}. `
                          + 'Confirm the behaviour change here is safe for that consumer.',
                    suggestion: isBreaking
                        ? `Update ${dep.repoId} in the same release, or keep a deprecated alias for one cycle.`
                        : `Check ${dep.repoId} still behaves correctly against the new implementation.`,
                    confidence: isBreaking ? 0.8 : 0.5,
                    crossRepo: { repoId: dep.repoId, role: dep.role, symbol: hit.symbol, files, renamed },
                });
            }
        }

        return findings;
    }
}

export default ReviewCrossRepoService;

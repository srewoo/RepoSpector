/**
 * reviewContextBudget — how much of the indexed repo is allowed into a review
 * prompt.
 *
 * RepoSpector indexes every code file in the repository: embeddings, a BM25
 * index, and a tree-sitter code graph, all in IndexedDB. Almost none of it
 * reached the model. The limits were scattered as literals across three files —
 * `ragChunks.slice(0, 3)`, `substring(0, 600)`, `slice(0, 4000)` — which added
 * up to roughly 1.5k tokens of repo context per review call, out of a complete
 * index.
 *
 * Those numbers were reasonable when they were written and are not any more:
 * context windows have grown by orders of magnitude, and prompt caching now
 * makes a large STABLE context block cheap on every call after the first (see
 * `promptCache.js`). Raising them is close to free where the block is shared.
 *
 * ── An honest caveat, because it cuts against this whole module ──
 *
 * The eval harness found that misses concentrate in LARGE files and read the
 * pattern as "attention dilution on big files rather than a rule gap". If that
 * is right, more context can make results WORSE. So these are tunables with a
 * documented A/B path, not a one-way ratchet:
 *
 *   node eval/run.js --corpus eval/corpus/injected.json          # current
 *   REPOSPECTOR_CONTEXT_PROFILE=legacy node eval/run.js ...      # pre-change
 *
 * Ship the profile the numbers support, not the one that sounds generous.
 */

/** What shipped before this module existed. Kept exactly, as the A/B baseline. */
export const LEGACY_BUDGET = Object.freeze({
    ragChunks: 3,
    ragChunkChars: 600,
    graphContextChars: 4000,
    graphMaxFiles: 12,
    graphCharsPerFile: 2500,
    graphSymbolsPerFile: 4,
    maxFullFiles: 10,
    callerSources: 0,
    callerSourceLines: 0,
});

/**
 * The raised defaults.
 *
 * `maxFullFiles` moves least (10 → 16) because it is the only budget here paid
 * in NETWORK requests rather than tokens: each file is a separate API call
 * against the user's rate limit, on the critical path of a review they are
 * waiting for. Token budgets are cheap to raise; round trips are not.
 */
export const DEFAULT_BUDGET = Object.freeze({
    /** Retrieved RAG chunks per review unit. */
    ragChunks: 8,
    /** Characters kept from each retrieved chunk. */
    ragChunkChars: 2000,
    /** Ceiling on the rendered code-graph block. */
    graphContextChars: 12000,
    /** Changed files the graph builds context for. */
    graphMaxFiles: 25,
    /** Characters of graph context per changed file. */
    graphCharsPerFile: 6000,
    /** Declared symbols queried per changed file. */
    graphSymbolsPerFile: 8,
    /** Files fetched in full from the host API (network-bound — see above). */
    maxFullFiles: 16,
    /** Callers whose SOURCE is inlined per changed symbol (see ReviewGraphContextService). */
    callerSources: 3,
    /** Lines of source shown per inlined caller. */
    callerSourceLines: 40,
});

const PROFILES = {
    default: DEFAULT_BUDGET,
    legacy: LEGACY_BUDGET,
};

/**
 * Resolve the active budget.
 *
 * Precedence, narrowest first: explicit per-call overrides, then the user's
 * review settings, then a named profile, then the defaults. Unknown keys are
 * dropped rather than merged, so a typo in settings cannot silently introduce a
 * budget nobody reads.
 *
 * @param {Object} [opts]
 * @param {string} [opts.profile] - 'default' | 'legacy'
 * @param {Object} [opts.settings] - reviewSettings.contextBudget from storage
 * @param {Object} [opts.overrides] - per-call overrides
 * @returns {Object} a complete budget
 */
export function resolveBudget(opts = {}) {
    const { profile, settings, overrides } = opts;
    const base = PROFILES[profile] || DEFAULT_BUDGET;

    const out = { ...base };
    for (const source of [settings, overrides]) {
        if (!source || typeof source !== 'object') continue;
        for (const key of Object.keys(DEFAULT_BUDGET)) {
            const value = source[key];
            // Guard the whole range: a negative or non-finite budget would
            // silently disable a context channel, which is far harder to notice
            // than an error.
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                out[key] = value;
            }
        }
    }
    return out;
}

export default { DEFAULT_BUDGET, LEGACY_BUDGET, resolveBudget };

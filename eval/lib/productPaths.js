/**
 * productPaths — three reviewers, three sets of numbers. P1-7.
 *
 * RepoSpector ships three materially different review paths and the harness
 * measured one of them. The extension runs the full pipeline; the API worker
 * uses a separate prompt and a simpler deep engine; MCP assembles evidence for
 * a host assistant that does the reasoning. Reporting one figure for "the
 * reviewer" is reporting a figure for whichever path happened to be measured.
 *
 * A run is therefore tagged with its path, results are never pooled across
 * paths, and a report that mixes them refuses rather than averages.
 */

export const PRODUCT_PATH = Object.freeze({
    /** The Chrome extension: full pipeline, all gates, all context channels. */
    EXTENSION: 'extension',
    /** The API worker: separate prompt, BackendDeepEngine, no explorer. */
    API: 'api',
    /** MCP evidence bundle plus a NAMED host agent doing the reasoning. */
    MCP_HOST: 'mcp-host',
});

/**
 * What each path is, and what a number from it does and does not describe.
 * Rendered into the report so a figure cannot be quoted without its scope.
 */
export const PATH_DESCRIPTION = Object.freeze({
    [PRODUCT_PATH.EXTENSION]:
        'Chrome extension: multi-pass engine, repository context, verification, '
        + 'scoring, precision gate, hypothesis validation and posting policy',
    [PRODUCT_PATH.API]:
        'API worker: separate prompt and deep engine, standards phase, adaptive '
        + 'filtering — no explorer, no scorer, no precision gate',
    [PRODUCT_PATH.MCP_HOST]:
        'MCP evidence bundle reasoned over by a named host agent; the number '
        + 'describes that agent as much as it describes RepoSpector',
});

export function normalizeProductPath(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return Object.values(PRODUCT_PATH).includes(v) ? v : PRODUCT_PATH.EXTENSION;
}

/**
 * Refuse to pool results from different paths.
 *
 * Returns the single path when every case agrees, and throws otherwise. An
 * average over two different reviewers is not a measurement of either.
 */
export function requireSinglePath(cases = []) {
    const paths = new Set(cases.map((c) => normalizeProductPath(c?.productPath)));
    if (paths.size > 1) {
        throw new Error(
            `Refusing to pool results across product paths (${[...paths].join(', ')}). `
            + 'Score each path separately: a combined figure describes no shipped reviewer.'
        );
    }
    return [...paths][0] ?? PRODUCT_PATH.EXTENSION;
}

/**
 * For `mcp-host`, the host agent is part of the system under test and must be
 * named. "MCP scored X" without it is unreproducible.
 */
export function describeHostAgent(manifest) {
    if (normalizeProductPath(manifest?.productPath) !== PRODUCT_PATH.MCP_HOST) return null;
    const agent = manifest?.hostAgent;
    if (!agent?.name) {
        return 'host agent NOT RECORDED — this figure is not reproducible and must not be quoted';
    }
    return `host agent: ${agent.name}${agent.version ? ` ${agent.version}` : ''}`
        + `${agent.model ? ` (${agent.model})` : ''}`;
}

export default {
    PRODUCT_PATH,
    PATH_DESCRIPTION,
    normalizeProductPath,
    requireSinglePath,
    describeHostAgent,
};

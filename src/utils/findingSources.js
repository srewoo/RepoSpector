/**
 * Which finding `source` values are FACTS (deterministic tools reading code or
 * the graph) versus model output. The distinction decides who gets refuted,
 * which bucket a finding renders in, and how it is labelled on the PR.
 */
export const DETERMINISTIC_SOURCES = Object.freeze(['static', 'external', 'graph']);

export function isDeterministicSource(source) {
    return DETERMINISTIC_SOURCES.includes(source);
}

export default { DETERMINISTIC_SOURCES, isDeterministicSource };

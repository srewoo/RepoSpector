/**
 * manifest — what this run WAS, recorded with its numbers. P1-7.
 *
 * A benchmark figure with no record of the pipeline that produced it cannot be
 * compared to the next one, which is how "recall improved" gets said about a
 * run that also changed the model, the context profile and three feature flags.
 * The manifest is written alongside every result set so any two runs can be
 * diffed before their numbers are.
 */

import { PIPELINE_VERSION } from '../../src/utils/reviewFingerprint.js';
import { normalizeProductPath } from './productPaths.js';

/** Flags that change what a review SAYS. Recorded exhaustively, by name. */
export const RECORDED_FLAGS = Object.freeze([
    'multiFinder', 'finderMode', 'finderRounds',
    'scoreFindings', 'precisionGate', 'graphFindings',
    'hypothesisValidation', 'llmRefutation',
    'dynamicContext', 'contextProfile', 'filterMode', 'failLevel',
    'maxFilesToReview', 'hunkWindowing',
]);

export function buildManifest({
    productPath = 'extension',
    model = null,
    provider = null,
    promptVersion = null,
    opts = {},
    hostAgent = null,
    contextCoverage = null,
    cost = null,
    latencyMs = null,
    corpus = null,
} = {}) {
    const flags = {};
    for (const key of RECORDED_FLAGS) {
        if (opts[key] !== undefined) flags[key] = opts[key];
    }

    return {
        recordedAt: new Date().toISOString(),
        productPath: normalizeProductPath(productPath),
        pipelineVersion: PIPELINE_VERSION,
        model,
        provider,
        promptVersion,
        flags,
        // For `mcp-host`, the host agent is part of the system under test. A
        // number produced without naming it is not reproducible.
        hostAgent,
        // What the run actually READ — from the completeness and coverage
        // contracts (P0-1, P1-5). Two runs with the same flags and different
        // coverage are not comparable, and this is what makes that visible.
        contextCoverage,
        cost,
        latencyMs,
        corpus,
    };
}

/**
 * Everything that differs between two runs, so a comparison can state its own
 * confounds instead of implying there are none.
 */
export function diffManifests(a, b) {
    const diffs = [];
    const compare = (label, x, y) => {
        if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ key: label, from: x, to: y });
    };

    for (const key of ['productPath', 'pipelineVersion', 'model', 'provider', 'promptVersion']) {
        compare(key, a?.[key], b?.[key]);
    }
    const keys = new Set([...Object.keys(a?.flags ?? {}), ...Object.keys(b?.flags ?? {})]);
    for (const key of keys) compare(`flags.${key}`, a?.flags?.[key], b?.flags?.[key]);

    return diffs;
}

/** One line per confound, for the head of a comparison. */
export function describeManifestDiff(diffs = []) {
    if (!diffs.length) return 'Runs are comparable: no recorded input differs.';
    return [
        `${diffs.length} recorded input(s) differ between these runs — any change in the`,
        'numbers below may be attributable to these rather than to what you changed:',
        ...diffs.map((d) => `  ${d.key}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`),
    ].join('\n');
}

export default { buildManifest, diffManifests, describeManifestDiff, RECORDED_FLAGS };

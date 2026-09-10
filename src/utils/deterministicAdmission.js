/**
 * deterministicAdmission — one reporting contract for findings that did not
 * come from a model. P1-3.
 *
 * Three separate places in the review handler appended findings AFTER the
 * precision gate, each with its own comment explaining why that source deserved
 * to bypass it: external scanner reports, graph-impact findings, and
 * missing-test findings. The reasoning was sound in each case and wrong in
 * aggregate — "did not come from a model" became "needs no validation", and
 * everything that arrived that way was reported in the same voice as a defect
 * the pipeline had actually established.
 *
 * The gate stays about model output. What replaces the bypass is a
 * provenance-specific admission: each source must carry the fields that make
 * its claim checkable, and every admitted finding is stamped with the strength
 * of claim it is entitled to make.
 */

import { ASSERTION } from '../services/GraphImpactFindingsService.js';

export { ASSERTION };

/** What each source must carry to be reportable at all. */
const REQUIRED = {
    scanner: ['tool', 'ruleId'],
    graph: ['rule'],
    'missing-test': ['rule'],
};

/**
 * Admit a batch of deterministic findings.
 *
 * @param {Array<object>} findings
 * @param {'scanner'|'graph'|'missing-test'} kind
 * @param {{revision?: string|null}} [context]
 * @returns {{admitted: Array<object>, rejected: Array<object>, stats: object}}
 */
export function admitDeterministic(findings = [], kind = 'scanner', context = {}) {
    const required = REQUIRED[kind] ?? [];
    const admitted = [];
    const rejected = [];

    for (const finding of findings || []) {
        if (!finding || typeof finding !== 'object') continue;

        const missing = required.filter((field) => !finding[field]);
        if (missing.length) {
            // A scanner finding with no rule id cannot be looked up, suppressed
            // or argued with. Reporting it anyway is the same unfalsifiable
            // output the gate exists to keep out.
            rejected.push({ ...finding, _admissionDrop: `missing provenance: ${missing.join(', ')}` });
            continue;
        }

        admitted.push({
            ...finding,
            deterministic: true,
            // A finding that already declared its own strength keeps it — the
            // graph signature rule distinguishes a call site it READ from one it
            // could not, and that distinction must not be flattened here.
            assertionLevel: finding.assertionLevel ?? defaultAssertion(kind),
            attribution: {
                kind,
                tool: finding.tool ?? finding.source ?? kind,
                rule: finding.rule ?? finding.ruleId ?? null,
                revision: context.revision ?? finding.revision ?? null,
            },
            // Only a finding validated in THIS review may block a merge on its
            // own. `deterministic` was doing that job, and it means "not model
            // output", which is a different claim.
            //
            // The scanner carve-out is deliberate and narrow: a team whose
            // CodeQL criticals have always gated merges keeps that by marking
            // the finding blocking upstream. What it does NOT get is a
            // pre-existing match blocking on severity alone, which is the
            // "pre-existing finding became an asserted regression" failure.
            blocking: finding.assertionLevel === ASSERTION.VALIDATED
                || (kind === 'scanner' && finding.blocking === true),
        });
    }

    return {
        admitted,
        rejected,
        stats: {
            kind,
            in: (findings || []).length,
            admitted: admitted.length,
            rejected: rejected.length,
            byAssertion: admitted.reduce((acc, f) => {
                acc[f.assertionLevel] = (acc[f.assertionLevel] || 0) + 1;
                return acc;
            }, {}),
        },
    };
}

function defaultAssertion(kind) {
    if (kind === 'scanner') return ASSERTION.TOOL_REPORTED;
    return ASSERTION.GRAPH_INFERRED;
}

/**
 * One sentence per source describing what the reader is looking at, so a
 * scanner match is not read as an independently reproduced failure.
 */
export function describeAssertion(level) {
    switch (level) {
        case ASSERTION.VALIDATED:
            return 'checked against source in this review';
        case ASSERTION.TOOL_REPORTED:
            return 'reported by a scanner; not independently reproduced here';
        default:
            return 'inferred from the code graph; not confirmed against source';
    }
}

export default { admitDeterministic, describeAssertion, ASSERTION };

/**
 * candidateDefence — the second runtime-neutral slice. P2-2.
 *
 * Where `findingPipeline.js` decides what a reviewer will SEE, this decides
 * what survives being argued with: every candidate gets a rule it can be
 * looked up by, and then the deterministic evidence gates try to disprove it.
 *
 * Extracted for the same reason as the first slice and with the same shape —
 * findings in, findings out, every collaborator injected, no chrome API, no
 * fetch, no storage. The API worker runs neither stage today and can adopt
 * either without re-deriving the order or the stats, which is the point of
 * putting them behind the seam rather than leaving them inline.
 *
 * One property is load-bearing and easy to lose in a refactor: BOTH stages
 * fail open. A citation enforcer that throws, or a verifier that cannot reach
 * its model, must return the candidates unchanged rather than an empty list.
 * Silence from a broken defence stage is indistinguishable from a clean review,
 * and that is the failure the completeness contract exists to prevent — so it
 * is asserted here rather than assumed.
 */

/** A stage that did not run is reported as null, never as "found nothing". */
const emptyStats = () => ({ citation: null, verification: null, scoring: null });

/**
 * @param {Array<object>} candidates
 * @param {object} deps
 * @param {(findings: Array) => {findings: Array, stats: object}} [deps.enforceCitations]
 * @param {{verify: Function}|null} [deps.verifier]
 * @param {{score: Function}|null} [deps.scorer]
 * @param {(stage: string, error: Error) => void} [deps.onStageError]
 * @param {object} input
 * @param {object} [input.prData]
 * @param {Map|null} [input.fileContext] post-change file bodies, so a quoted
 *   citation is checked against the FILE rather than only the diff (P1-2)
 * @param {object} [input.settings]
 * @param {object} [input.options]  { votes, llmRefutation, onProgress }
 * @returns {Promise<{findings: Array, dropped: Array, usage: object, stats: object}>}
 */
export async function defendCandidates(candidates = [], deps = {}, input = {}) {
    const { enforceCitations, verifier = null, scorer = null, onStageError = null } = deps;
    const stats = emptyStats();
    const usage = { input: 0, output: 0 };
    let findings = [...candidates];
    let dropped = [];

    const failOpen = (stage, error) => {
        // The candidates from before the stage are kept deliberately. A defence
        // stage that cannot run has established nothing — in either direction.
        onStageError?.(stage, error);
    };

    // ── Citations ────────────────────────────────────────────────────────────
    // Every finding ends up with a rule it can be looked up, suppressed or
    // argued with by. A finding nobody can cite is a finding nobody can dispute.
    if (enforceCitations) {
        try {
            const cited = enforceCitations(findings);
            findings = cited.findings;
            stats.citation = cited.stats;
        } catch (e) {
            failOpen('citations', e);
        }
    }

    // ── Adversarial verification ─────────────────────────────────────────────
    // The deterministic evidence gates: a cited line absent from the file, a
    // construct that exists only on removed lines, a quote that appears nowhere.
    // Free, and they run before anything that costs a token.
    if (verifier?.verify && findings.length > 0) {
        try {
            const result = await verifier.verify(findings, {
                prData: input.prData ?? {},
                fileContext: input.fileContext ?? null,
                settings: input.settings ?? {},
                votes: input.options?.votes,
                llmRefutation: input.options?.llmRefutation,
                onProgress: input.options?.onProgress,
            });
            findings = result.findings;
            dropped = [...dropped, ...(result.dropped ?? [])];
            stats.verification = result.stats;
            usage.input += result.usage?.input ?? 0;
            usage.output += result.usage?.output ?? 0;
        } catch (e) {
            failOpen('verification', e);
        }
    }

    // ── Value scoring ────────────────────────────────────────────────────────
    // Verification settled whether findings are real; this ranks the survivors
    // so a capped inline budget keeps the valuable ones. Optional: an absent or
    // failing scorer degrades ORDERING, and must never delete a finding — the
    // precision gate treats an unscored finding as an outage, not a verdict.
    if (scorer?.score && findings.length > 0) {
        try {
            const result = await scorer.score(findings, {
                prData: input.prData ?? {},
                settings: input.settings ?? {},
                onProgress: input.options?.onProgress,
            });
            findings = result.findings;
            stats.scoring = result.stats;
            usage.input += result.usage?.input ?? 0;
            usage.output += result.usage?.output ?? 0;
        } catch (e) {
            failOpen('scoring', e);
        }
    }

    return { findings, dropped, usage, stats };
}

export default { defendCandidates };

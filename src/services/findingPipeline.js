/**
 * findingPipeline — the first runtime-neutral slice of the review handler. P2-2.
 *
 * `prReviewHandlers.js` is where the actual review POLICY lives, which is why
 * the plan calls extracting it the riskiest refactor available and says to land
 * the completeness contract as a seam first rather than attempting it in one
 * move. That seam exists now (utils/reviewCompleteness.js), so this is the
 * first increment behind it.
 *
 * The slice is the stretch between "we have candidates" and "we have the list a
 * reviewer will see": the precision gate, the three deterministic admissions,
 * optional hypothesis validation, and diff scoping. It was chosen because it is
 * the part with no browser in it — no chrome APIs, no fetch, no storage, only
 * findings in and findings out — so it is the piece the API worker and any
 * future runtime can share without a shim.
 *
 * Everything it needs arrives as an injected adapter. Nothing here imports a
 * gate, a scanner or a validator directly: a caller supplies them, which is
 * what lets the extension pass its real ones, the worker pass a subset, and a
 * test pass fakes without a DOM.
 *
 * What it deliberately does NOT do: decide the verdict. That belongs to the
 * completeness contract, and duplicating the rule here is how two paths come to
 * disagree about when a review may approve.
 */

/** A stage that produced nothing is reported, not omitted. */
const emptyStats = () => ({
    precision: null,
    admission: [],
    validation: null,
    scope: null,
});

/**
 * @param {Array<object>} candidates
 * @param {object} deps
 * @param {(findings: Array, opts: object) => {findings: Array, dropped: Array, stats: object}} deps.precisionGate
 * @param {(findings: Array, kind: string, ctx: object) => {admitted: Array, rejected: Array, stats: object}} deps.admit
 * @param {(findings: Array, files: Array, opts: object) => {kept: Array, dropped: Array, stats: object}} deps.scope
 * @param {{validate: Function}|null} [deps.validator] optional; absent means source-only
 * @param {object} input
 * @param {Array} [input.external]      scanner findings, admitted after the gate
 * @param {Array} [input.graph]         graph-impact findings, admitted after the gate
 * @param {Array} [input.missingTests]  advisory coverage signals
 * @param {Array} [input.files]         the PR's changed files, for scoping
 * @param {object} [input.config]       { minConfidence, minScore, filterMode }
 * @param {string|null} [input.revision]
 * @param {string|null} [input.baseRevision]
 * @param {(f: object) => string} [input.keyOf] dedupe key for the admissions
 * @returns {Promise<{findings: Array, dropped: Array, preSuppressionCandidates: Array, stats: object}>}
 */
export async function runFindingPipeline(candidates = [], deps = {}, input = {}) {
    const {
        precisionGate,
        admit,
        scope,
        validator = null,
        onProgress = null,
    } = deps;

    const config = input.config ?? {};
    const keyOf = input.keyOf ?? ((f) => `${f.filePath || f.file}:${f.line}:${f.ruleId || f.rule}`);
    const stats = emptyStats();
    let dropped = [];
    let findings = [...candidates];

    // Kept before any model-based suppression: the host-agent stage exists to
    // rescue a real bug the pipeline under-investigated, and one already
    // deleted for scoring 6 cannot be rescued (P1-8).
    const preSuppressionCandidates = findings;

    // ── Precision gate ───────────────────────────────────────────────────────
    if (precisionGate) {
        const result = precisionGate(findings, {
            minConfidence: config.minConfidence,
            minScore: config.minScore,
        });
        findings = result.findings;
        dropped = [...dropped, ...result.dropped];
        stats.precision = result.stats;
        onProgress?.({ stage: 'precision-gate', stats: result.stats });
    }

    // ── Deterministic admission ──────────────────────────────────────────────
    //
    // Not a bypass. Each source must carry the provenance that makes its claim
    // checkable, and each is stamped with how strong a claim it may make, so a
    // scanner match is reported as a scanner match rather than as a defect this
    // review established (P1-3).
    if (admit) {
        const sources = [
            ['scanner', input.external ?? []],
            ['graph', input.graph ?? []],
            ['missing-test', input.missingTests ?? []],
        ];
        for (const [kind, incoming] of sources) {
            if (!incoming.length) continue;
            const present = new Set(findings.map(keyOf));
            const fresh = incoming.filter((f) => !present.has(keyOf(f)));
            if (!fresh.length) continue;

            const result = admit(fresh, kind, { revision: input.revision ?? null });
            findings = [...findings, ...result.admitted];
            dropped = [...dropped, ...result.rejected];
            stats.admission.push(result.stats);
            onProgress?.({ stage: 'deterministic-admission', kind, stats: result.stats });
        }
    }

    // ── Hypothesis validation ────────────────────────────────────────────────
    //
    // Optional in every direction. Absent, findings pass through unvalidated
    // and say so; present, a refuted candidate is withheld and an unresolved
    // one is kept carrying the record that it could not be settled (P1-6).
    if (validator?.validate) {
        const result = await validator.validate(findings, {
            revision: input.revision ?? null,
            baseRevision: input.baseRevision ?? null,
            limits: config.validationLimits,
        });
        const refuted = result.findings.filter((f) => f.validation?.status === 'refuted');
        findings = result.findings.filter((f) => f.validation?.status !== 'refuted');
        dropped = [...dropped, ...refuted.map((f) => ({ ...f, _precisionDrop: 'refuted-by-validation' }))];
        stats.validation = result.stats;
        onProgress?.({ stage: 'hypothesis-validation', stats: result.stats });
    }

    // ── Diff scope ───────────────────────────────────────────────────────────
    if (scope) {
        const result = scope(findings, input.files ?? [], { mode: config.filterMode });
        findings = result.kept;
        dropped = [...dropped, ...result.dropped];
        stats.scope = result.stats;
        onProgress?.({ stage: 'diff-scope', stats: result.stats });
    }

    return { findings, dropped, preSuppressionCandidates, stats };
}

export default { runFindingPipeline };

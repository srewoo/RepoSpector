/**
 * benchmarkReport — the report P1-7 asks for, and nothing it cannot support.
 *
 * The existing `formatReport` gives one precision figure and one recall figure.
 * Neither is the number a release decision needs:
 *
 *   - Precision on INLINE findings is what a reviewer actually sees on their
 *     diff, and it is a different (usually higher) number than precision over
 *     everything reported, because the posting policy demotes the weaker half
 *     to a summary. Publishing the second while shipping the first overstates
 *     what a user experiences; publishing only the first hides what the tool
 *     said. Both, separately.
 *   - Recall against ALL human comments scores a defect-only policy as missing
 *     every style comment ever written. The reviewer deliberately does not make
 *     those, so counting them measures a decision, not a capability. Defect
 *     recall and design/style agreement are split.
 *   - A clean PR has no reference defects at all, so it contributes nothing to
 *     either rate while being the case users complain about most. False
 *     positives per clean PR is its own number.
 *   - A run that could not read the change is not a run that found nothing.
 *     Incompleteness rate is reported, not folded in.
 */

import { wilson, pct, scorePrecisionBySource, matchReferences, sameLocation, mentionsIssue } from './scoring.js';
import { classifyClaim } from '../../src/utils/findingClaim.js';
import {
    PRODUCT_PATH,
    PATH_DESCRIPTION,
    requireSinglePath,
    describeHostAgent,
} from './productPaths.js';
import { scoreRetention, formatRetention } from './retention.js';
import { coverageOf, formatCoverage } from './caseCategories.js';

/**
 * Is this human comment a DEFECT report, or design/style agreement?
 *
 * An explicit `tagGroup` wins — a curated corpus knows better than a classifier.
 * Otherwise the same claim classifier the precision gate uses decides, which
 * keeps the benchmark's definition of "defect" identical to the product's
 * instead of letting the two drift into scoring different things.
 */
export function classifyReference(reference) {
    const group = String(reference?.tagGroup ?? '').toLowerCase();
    if (group === 'style' || group === 'design' || group === 'convention') return 'design-style';
    if (group) return 'defect';

    // The body goes in as the TITLE, not the description. `claimTextOf` strips
    // advice-shaped sentences out of a description, which is right for a
    // reviewer's finding — the advice is not the claim — and wrong for a human
    // comment, where "please rename this" IS the whole claim. Stripping it left
    // an empty claim that fell through to "defect", and every style comment in
    // the corpus counted against defect recall.
    const claim = classifyClaim({
        title: reference?.body ?? reference?.title ?? reference?.description ?? null,
        category: reference?.category ?? null,
    });
    return claim.commentary ? 'design-style' : 'defect';
}

/** A PR with no reference defect is a clean PR: every finding on it is a cost. */
export function isCleanCase(kase) {
    if (typeof kase?.clean === 'boolean') return kase.clean;
    const refs = (kase?.humanComments ?? []).filter((c) => c?.substantive !== false);
    return refs.filter((r) => classifyReference(r) === 'defect').length === 0;
}

/**
 * @param {Array} cases   corpus cases, each with predictions/adjudications/humanComments
 * @param {object} [options]
 * @param {number} [options.tolerance]
 * @param {object} [options.manifest] the run manifest (flags, versions, cost)
 * @returns {object}
 */
export function buildBenchmarkReport(cases = [], options = {}) {
    const tolerance = options.tolerance ?? 5;
    const productPath = requireSinglePath(cases);

    const allPredictions = [];
    const allAdjudications = [];
    const inlinePredictions = [];

    let defectMatched = 0;
    let defectTotal = 0;
    let styleMatched = 0;
    let styleTotal = 0;

    let cleanCases = 0;
    let cleanQuiet = 0;
    let findingsOnCleanCases = 0;
    let incompleteCases = 0;
    let locationMatched = 0;
    let issueMatched = 0;

    // Precision as bounds, the way OpenQodex reports it: a finding is correct
    // when a human says so or it hits a reference defect, wrong when a human
    // says so or it sits on a clean case, and otherwise unresolved. The lower
    // bound counts every unresolved finding wrong, the upper counts it right.
    const bounds = { correct: 0, wrong: 0, unresolved: 0 };

    const perReview = { reviews: 0, wallMs: 0, timed: 0, tokensIn: 0, tokensOut: 0, metered: 0 };

    const retentionStages = [];

    for (const kase of cases) {
        const predictions = kase.predictions ?? [];
        const adjudications = kase.adjudications ?? [];
        // Namespaced exactly as `scoreRun` does, so a shared path in two PRs
        // cannot cross-match during pooling.
        const tag = (r) => ({ ...r, file: `${kase.id}::${r.file ?? r.filePath ?? r.path ?? ''}` });

        allPredictions.push(...predictions.map(tag));
        allAdjudications.push(...adjudications.map(tag));
        inlinePredictions.push(...predictions.filter((p) => p.posted).map(tag));

        const references = (kase.humanComments ?? []).filter((c) => c?.substantive !== false);
        const defects = references.filter((r) => classifyReference(r) === 'defect');
        const styles = references.filter((r) => classifyReference(r) !== 'defect');

        // Matched one-to-one (P0-3), separately per bucket so a prediction
        // cannot satisfy a defect and a style comment at once.
        defectTotal += defects.length;
        defectMatched += matchReferences(predictions, defects, tolerance).matched.length;
        styleTotal += styles.length;
        styleMatched += matchReferences(predictions, styles, tolerance).matched.length;

        // Location recall at ±1 line, whatever the finding says.
        locationMatched += matchReferences(predictions, defects, 1).matched.length;
        // Issue recall: the finding overlaps the defect's lines AND names it.
        issueMatched += matchReferences(predictions, defects, 0, mentionsIssue).matched.length;

        const clean = isCleanCase(kase);
        const incomplete = kase.incomplete === true || kase.stats?.incomplete === true
            || kase.runStats?.incomplete === true;
        if (clean) {
            cleanCases++;
            findingsOnCleanCases += predictions.length;
            // A clean change passes only a COMPLETE review with no finding.
            if (!incomplete && predictions.length === 0) cleanQuiet++;
        }
        if (incomplete) incompleteCases++;

        const human = scorePrecisionBySource(predictions, adjudications, tolerance).human.outcomes;
        // Not one-to-one: a second finding on a found defect is a duplicate, and
        // a finding on a side issue the case accepts as real is correct too.
        const names = (p, refs) => refs.some((r) => sameLocation(p, r, tolerance) && mentionsIssue(p, r));
        const accepted = kase.acceptedIssues ?? [];
        predictions.forEach((p, i) => {
            if (human[i] === 'tp') bounds.correct++;
            else if (human[i] === 'fp') bounds.wrong++;
            else if (human[i] === 'disputed') bounds.unresolved++;
            else if (!clean && (names(p, defects) || names(p, accepted))) bounds.correct++;
            else if (clean) bounds.wrong++;
            else bounds.unresolved++;
        });

        const wallMs = kase.runStats?.wallMs ?? kase.manifest?.latencyMs;
        if (kase.runStats || kase.manifest) perReview.reviews++;
        if (Number.isFinite(wallMs)) { perReview.wallMs += wallMs; perReview.timed++; }
        const tokens = kase.runStats?.tokens;
        if (tokens && Number.isFinite(tokens.input)) {
            perReview.tokensIn += tokens.input;
            perReview.tokensOut += tokens.output ?? 0;
            perReview.metered++;
        }
        if (kase.retention) retentionStages.push(...scoreRetention(kase.retention, adjudications));
    }

    const allPrecision = scorePrecisionBySource(allPredictions, allAdjudications, tolerance);
    const inlinePrecision = scorePrecisionBySource(inlinePredictions, allAdjudications, tolerance);

    // Fold per-case retention into one table per stage.
    const byStage = new Map();
    for (const s of retentionStages) {
        const entry = byStage.get(s.stage) ?? {
            stage: s.stage, in: 0, out: 0, added: 0,
            droppedCount: 0, trueDropped: 0, falseDropped: 0, unknownDropped: 0,
        };
        for (const k of ['in', 'out', 'added', 'droppedCount', 'trueDropped', 'falseDropped', 'unknownDropped']) {
            entry[k] += s[k];
        }
        byStage.set(s.stage, entry);
    }

    return {
        productPath,
        pathDescription: PATH_DESCRIPTION[productPath],
        hostAgent: describeHostAgent(options.manifest),
        manifest: options.manifest ?? null,
        cases: cases.length,
        tolerance,

        /** What a reviewer sees on their diff. */
        inlinePrecision: inlinePrecision.human,
        inlinePrecisionLlm: inlinePrecision.llm,
        /** Everything the tool reported, inline and summary. */
        reportedPrecision: allPrecision.human,
        reportedPrecisionLlm: allPrecision.llm,

        /** Human comments the reviewer is TRYING to reproduce. */
        defectRecall: { matched: defectMatched, reference: defectTotal, ...wilson(defectMatched, defectTotal) },
        /** Human comments it deliberately does not make. Reported, never pooled. */
        designStyleAgreement: { matched: styleMatched, reference: styleTotal, ...wilson(styleMatched, styleTotal) },

        precisionBounds: precisionBounds(bounds),
        issueRecall: { matched: issueMatched, reference: defectTotal, ...wilson(issueMatched, defectTotal) },
        locationRecall: { matched: locationMatched, reference: defectTotal, ...wilson(locationMatched, defectTotal) },

        cleanCases,
        cleanQuiet,
        cleanRate: { matched: cleanQuiet, reference: cleanCases, ...wilson(cleanQuiet, cleanCases) },
        findingsOnCleanCases,
        falsePositivesPerCleanCase: cleanCases ? findingsOnCleanCases / cleanCases : null,

        incompleteCases,
        incompletenessRate: cases.length ? incompleteCases / cases.length : null,

        retention: [...byStage.values()],
        // Which case shapes this corpus actually contains. An absent shape is
        // not a passing one, and the report says so rather than averaging over
        // whatever happened to be in the file.
        coverage: coverageOf(cases),
        perReview: perReviewCost(perReview, options.price),
    };
}

function precisionBounds({ correct, wrong, unresolved }) {
    const total = correct + wrong + unresolved;
    return {
        correct, wrong, unresolved, total,
        lower: total ? correct / total : null,
        upper: total ? (correct + unresolved) / total : null,
    };
}

/**
 * Mean time, tokens and cost per review. Cost needs a price in USD per million
 * tokens (`{input, output}`); without one it is null, never guessed.
 */
export function perReviewCost(p, price = null) {
    const tokensIn = p.metered ? p.tokensIn / p.metered : null;
    const tokensOut = p.metered ? p.tokensOut / p.metered : null;
    const cost = price && tokensIn != null
        ? (tokensIn * price.input + tokensOut * price.output) / 1e6
        : null;
    return {
        reviews: p.reviews,
        wallMs: p.timed ? p.wallMs / p.timed : null,
        tokensIn,
        tokensOut,
        cost,
    };
}

export function formatBenchmarkReport(report) {
    const r = report;
    const lines = [
        `Product path:      ${r.productPath}`,
        `                   ${r.pathDescription}`,
        ...(r.hostAgent ? [`                   ${r.hostAgent}`] : []),
        `Cases:             ${r.cases}   (line tolerance ±${r.tolerance})`,
        '',
        `Inline precision:  ${pct(r.inlinePrecision.rate)}  [${pct(r.inlinePrecision.low)} – ${pct(r.inlinePrecision.high)}]   `
            + `${r.inlinePrecision.truePositives}/${r.inlinePrecision.adjudicated}   what a reviewer sees on the diff`,
        `Reported precision:${pct(r.reportedPrecision.rate)}  [${pct(r.reportedPrecision.low)} – ${pct(r.reportedPrecision.high)}]   `
            + `${r.reportedPrecision.truePositives}/${r.reportedPrecision.adjudicated}   inline and summary together`,
        '',
        `Defect recall:     ${pct(r.defectRecall.rate)}  [${pct(r.defectRecall.low)} – ${pct(r.defectRecall.high)}]   `
            + `${r.defectRecall.matched}/${r.defectRecall.reference} human DEFECT comments matched`,
        `Design/style:      ${pct(r.designStyleAgreement.rate)}   `
            + `${r.designStyleAgreement.matched}/${r.designStyleAgreement.reference}   `
            + 'reported separately — the reviewer does not attempt these',
        '',
        `Issue recall:      ${pct(r.issueRecall.rate)}  [${pct(r.issueRecall.low)} – ${pct(r.issueRecall.high)}]   `
            + `${r.issueRecall.matched}/${r.issueRecall.reference} defects with a finding on their lines that names them`,
        `Location recall:   ${pct(r.locationRecall.rate)}   `
            + `${r.locationRecall.matched}/${r.locationRecall.reference} defects with a finding within ±1 line`,
        `Precision bounds:  ${pct(r.precisionBounds.lower)} to ${pct(r.precisionBounds.upper)}   `
            + `${r.precisionBounds.correct}/${r.precisionBounds.total} to `
            + `${r.precisionBounds.correct + r.precisionBounds.unresolved}/${r.precisionBounds.total}   `
            + `(${r.precisionBounds.unresolved} unresolved: wrong in the lower bound, right in the upper)`,
        '',
        `Clean rate:        ${pct(r.cleanRate.rate)}  [${pct(r.cleanRate.low)} – ${pct(r.cleanRate.high)}]   `
            + `${r.cleanQuiet}/${r.cleanCases} clean PRs reviewed completely with no finding`,
        `Clean PRs:         ${r.cleanCases}   `
            + `${r.falsePositivesPerCleanCase == null ? 'n/a' : r.falsePositivesPerCleanCase.toFixed(2)} finding(s) per clean PR`,
        `Incompleteness:    ${r.incompletenessRate == null ? 'n/a' : pct(r.incompletenessRate)}   `
            + `${r.incompleteCases} run(s) could not read the whole change`,
    ];

    const pr = r.perReview;
    lines.push(
        `Time per review:   ${pr.wallMs == null ? 'not measured' : `${(pr.wallMs / 1000).toFixed(1)} s`}`,
        `Tokens per review: ${pr.tokensIn == null ? 'not measured' : `${Math.round(pr.tokensIn)} in / ${Math.round(pr.tokensOut)} out`}`,
        `Cost per review:   ${pr.cost == null ? 'not measured (pass --price <in>,<out> USD per 1M tokens)' : `$${pr.cost.toFixed(4)}`}`,
    );

    const retention = formatRetention(r.retention);
    if (retention) lines.push(retention);

    const coverage = formatCoverage(r.coverage);
    if (coverage) lines.push(coverage);

    if (r.manifest) {
        lines.push(
            '',
            'Run manifest:',
            `  pipeline ${r.manifest.pipelineVersion ?? '?'}  model ${r.manifest.model ?? '?'}  `
                + `prompt ${r.manifest.promptVersion ?? '?'}`,
            `  flags: ${Object.entries(r.manifest.flags ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'none recorded'}`,
        );
    }

    // The figures are lower bounds on small samples, and the target is stated as
    // one. Saying so in the report is the difference between a target and a claim.
    lines.push(
        '',
        'Rates are Wilson 95% intervals; gate on the LOWER BOUND, not the point estimate.',
    );
    return lines.join('\n');
}

export default {
    buildBenchmarkReport,
    formatBenchmarkReport,
    classifyReference,
    isCleanCase,
    PRODUCT_PATH,
};

/**
 * scoring — precision / recall for a review run, with honest intervals.
 *
 * A code reviewer has two failure modes and they trade against each other:
 *
 *   PRECISION — of the findings we posted, how many were real? Low precision
 *   trains the reviewer to collapse the bot, which costs us the true positives
 *   as well. Measured against human adjudication of each finding.
 *
 *   RECALL — of the comments a human actually left on the MR, how many did we
 *   also raise? A reviewer that says nothing has perfect precision.
 *
 * Both are proportions from small samples, so a bare percentage is misleading:
 * 1/1 is not "100% precision". Every rate here is reported with a Wilson score
 * interval, and the GATE compares LOWER BOUNDS. That is deliberate — it is the
 * number you can defend, and it stops a lucky 3-MR run from ratcheting the
 * threshold up to somewhere the next run cannot reach.
 */

/** Line distance within which a predicted finding is considered co-located. */
export const DEFAULT_LINE_TOLERANCE = 5;

/** Normalize a path for comparison: no leading ./, no leading/trailing slash. */
function normPath(p) {
    return String(p ?? '')
        .replace(/^\.\//, '')
        .replace(/^\/+|\/+$/g, '')
        .trim();
}

/** File + line of a record, whatever shape the producer used. */
export function locationOf(record) {
    const file = normPath(record?.file ?? record?.filePath ?? record?.path ?? '');
    const raw = record?.line ?? record?.lineNumber ?? record?.startLine;
    const line = Number.isFinite(Number(raw)) ? Number(raw) : null;
    return { file, line };
}

/**
 * Do a prediction and a reference point at the same place?
 *
 * A reference with no line matches anywhere in the file: humans routinely
 * comment on a file as a whole, and refusing those would understate recall.
 */
export function sameLocation(a, b, tolerance = DEFAULT_LINE_TOLERANCE) {
    const la = locationOf(a);
    const lb = locationOf(b);
    if (!la.file || !lb.file || la.file !== lb.file) return false;
    if (la.line == null || lb.line == null) return true;
    return Math.abs(la.line - lb.line) <= tolerance;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Chosen over the normal approximation because it stays inside [0, 1] and
 * stays sane at 0 successes — which is exactly the regime the first measured
 * run of this reviewer was in (0 of 42 correct).
 *
 * @param {number} successes
 * @param {number} total
 * @param {number} [z=1.96] - 1.96 ⇒ 95%
 * @returns {{rate: number|null, low: number, high: number, n: number}}
 */
export function wilson(successes, total, z = 1.96) {
    const n = Number(total) || 0;
    const k = Number(successes) || 0;
    if (n === 0) return { rate: null, low: 0, high: 1, n: 0 };

    const p = k / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

    return {
        rate: p,
        low: Math.max(0, (centre - margin) / denom),
        high: Math.min(1, (centre + margin) / denom),
        n,
    };
}

/**
 * Precision over adjudicated findings.
 *
 * Only findings a human labelled count. An unlabelled finding is not scored
 * either way — silently treating it as wrong would punish a reviewer for
 * findings nobody got round to judging.
 *
 * @param {Array<{id?:string, file:string, line?:number}>} predictions
 * @param {Array<{file:string, line?:number, verdict:'true_positive'|'false_positive'}>} adjudications
 * @param {number} [tolerance]
 */
export function scorePrecision(predictions = [], adjudications = [], tolerance = DEFAULT_LINE_TOLERANCE) {
    let truePositives = 0;
    let falsePositives = 0;
    let unadjudicated = 0;

    for (const p of predictions) {
        const verdicts = adjudications.filter(a => sameLocation(p, a, tolerance));
        if (verdicts.length === 0) { unadjudicated++; continue; }
        // Any human calling it real makes it real; adjudicators disagree and the
        // conservative reading of a split is "this was worth saying".
        if (verdicts.some(v => v.verdict === 'true_positive')) truePositives++;
        else falsePositives++;
    }

    const interval = wilson(truePositives, truePositives + falsePositives);
    return {
        truePositives,
        falsePositives,
        unadjudicated,
        adjudicated: truePositives + falsePositives,
        predicted: predictions.length,
        ...interval,
    };
}

/**
 * Recall against the comments a human actually left.
 *
 * @param {Array} predictions
 * @param {Array<{file:string, line?:number, substantive?:boolean}>} humanComments
 * @param {number} [tolerance]
 */
export function scoreRecall(predictions = [], humanComments = [], tolerance = DEFAULT_LINE_TOLERANCE) {
    // "LGTM", "nice", approvals — a reviewer is not expected to reproduce those,
    // and counting them makes recall look worse than the tool is.
    const reference = humanComments.filter(c => c?.substantive !== false);

    const matched = [];
    const missed = [];
    for (const c of reference) {
        if (predictions.some(p => sameLocation(p, c, tolerance))) matched.push(c);
        else missed.push(c);
    }

    return {
        matched: matched.length,
        missed: missed.length,
        reference: reference.length,
        missedExamples: missed.slice(0, 10),
        ...wilson(matched.length, reference.length),
    };
}

/**
 * Recall broken down by a reference's `tag` / `tagGroup`.
 *
 * A single detection rate hides the actionable part: 33% could mean "finds a
 * third of everything" or "finds every injection and no unchecked-error". Only
 * references that carry a tag are grouped, so this is silent on a corpus of
 * untagged human comments rather than inventing buckets for it.
 *
 * @param {Array} predictions
 * @param {Array} references
 * @param {number} [tolerance]
 * @param {'tag'|'tagGroup'} [key]
 * @returns {Array<{key:string, matched:number, total:number, rate:number}>}
 */
export function recallByTag(predictions = [], references = [], tolerance = DEFAULT_LINE_TOLERANCE, key = 'tag') {
    const buckets = new Map();
    for (const ref of references) {
        const bucket = ref?.[key];
        if (!bucket) continue;
        if (!buckets.has(bucket)) buckets.set(bucket, { key: bucket, matched: 0, total: 0 });
        const entry = buckets.get(bucket);
        entry.total++;
        if (predictions.some(p => sameLocation(p, ref, tolerance))) entry.matched++;
    }
    return [...buckets.values()]
        .map(b => ({ ...b, rate: b.total ? b.matched / b.total : null }))
        .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/** Harmonic mean of two rates; null when either is unmeasurable. */
export function f1(precisionRate, recallRate) {
    if (precisionRate == null || recallRate == null) return null;
    if (precisionRate + recallRate === 0) return 0;
    return (2 * precisionRate * recallRate) / (precisionRate + recallRate);
}

/**
 * Score a whole run: many MRs, each with predictions, adjudications and human
 * comments.
 *
 * Findings are POOLED across MRs rather than averaged per MR. Averaging rates
 * gives a 1-finding MR the same weight as a 40-finding one, which is how a
 * single lucky small MR ends up flattering the whole run.
 *
 * @param {Array<{id:string, predictions:Array, adjudications:Array, humanComments:Array}>} cases
 * @param {{tolerance?:number}} [options]
 */
export function scoreRun(cases = [], options = {}) {
    const tolerance = options.tolerance ?? DEFAULT_LINE_TOLERANCE;

    const allPredictions = [];
    const allAdjudications = [];
    const allHumanComments = [];
    const perCase = [];

    for (const c of cases) {
        const predictions = c.predictions ?? [];
        const adjudications = c.adjudications ?? [];
        const humanComments = c.humanComments ?? [];

        // Namespace by case id so a `src/app.js` in MR 1 cannot match a
        // `src/app.js` in MR 2 during pooled scoring.
        const tag = (r) => ({ ...r, file: `${c.id}::${normPath(r.file ?? r.filePath ?? r.path)}` });

        allPredictions.push(...predictions.map(tag));
        allAdjudications.push(...adjudications.map(tag));
        allHumanComments.push(...humanComments.map(tag));

        const precision = scorePrecision(predictions, adjudications, tolerance);
        const recall = scoreRecall(predictions, humanComments, tolerance);
        perCase.push({ id: c.id, precision, recall, f1: f1(precision.rate, recall.rate) });
    }

    const precision = scorePrecision(allPredictions, allAdjudications, tolerance);
    const recall = scoreRecall(allPredictions, allHumanComments, tolerance);

    return {
        cases: cases.length,
        tolerance,
        precision,
        recall,
        f1: f1(precision.rate, recall.rate),
        byTag: recallByTag(allPredictions, allHumanComments, tolerance, 'tag'),
        byTagGroup: recallByTag(allPredictions, allHumanComments, tolerance, 'tagGroup'),
        perCase,
    };
}

/** Percentage string, or `n/a` when the sample was empty. */
export function pct(rate) {
    return rate == null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

/** Human-readable report for a `scoreRun` result. */
export function formatReport(result) {
    const { precision: p, recall: r } = result;
    const tagLines = (result.byTag ?? []).length
        ? ['', 'Detection by defect class:',
            ...result.byTag.map(t =>
                `  ${t.key.padEnd(24)} ${String(t.matched).padStart(2)}/${String(t.total).padEnd(2)}  ${pct(t.rate)}`)]
        : [];
    return [
        `MRs scored:        ${result.cases}   (line tolerance ±${result.tolerance})`,
        '',
        `Precision:         ${pct(p.rate)}  [${pct(p.low)} – ${pct(p.high)}]   ` +
            `${p.truePositives}/${p.adjudicated} adjudicated findings correct`,
        `Recall:            ${pct(r.rate)}  [${pct(r.low)} – ${pct(r.high)}]   ` +
            `${r.matched}/${r.reference} human comments matched`,
        `F1:                ${pct(result.f1)}`,
        '',
        `Findings produced: ${p.predicted}   (${p.unadjudicated} not yet adjudicated)`,
        ...tagLines,
    ].join('\n');
}

export default {
    scoreRun,
    recallByTag,
    scorePrecision,
    scoreRecall,
    wilson,
    f1,
    sameLocation,
    locationOf,
    formatReport,
    pct,
    DEFAULT_LINE_TOLERANCE,
};

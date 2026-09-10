/**
 * corpus — load and validate an evaluation set.
 *
 * A case is one MR with three lists:
 *
 *   predictions   what RepoSpector reported          (from a review run)
 *   adjudications a human's verdict on each of those (precision ground truth)
 *   humanComments what a human reviewer actually said (recall ground truth)
 *
 * Validation is strict and fails loudly. A silently-skipped malformed case
 * inflates every rate it was supposed to lower, which is the one failure mode
 * a measurement harness must not have.
 */

const VERDICTS = new Set(['true_positive', 'false_positive']);

/** Throw with the case id in the message — a bare "invalid" is unactionable. */
function fail(where, message) {
    throw new Error(`Eval corpus invalid at ${where}: ${message}`);
}

function validateLocated(record, where, { requireLine = false } = {}) {
    if (!record || typeof record !== 'object') fail(where, 'entry is not an object');
    const file = record.file ?? record.filePath ?? record.path;
    if (!file || typeof file !== 'string') fail(where, 'missing `file`');
    if (record.line != null && !Number.isFinite(Number(record.line))) {
        fail(where, `\`line\` is not a number: ${JSON.stringify(record.line)}`);
    }
    if (requireLine && record.line == null) fail(where, 'missing `line`');
}

/**
 * Validate one case, returning it normalized.
 * @param {object} raw
 * @param {number} index
 */
export function validateCase(raw, index) {
    const where = raw?.id ? `case "${raw.id}"` : `case #${index}`;
    if (!raw || typeof raw !== 'object') fail(where, 'not an object');
    if (!raw.id || typeof raw.id !== 'string') fail(where, 'missing string `id`');

    const predictions = raw.predictions ?? [];
    const adjudications = raw.adjudications ?? [];
    const humanComments = raw.humanComments ?? [];

    if (!Array.isArray(predictions)) fail(where, '`predictions` must be an array');
    if (!Array.isArray(adjudications)) fail(where, '`adjudications` must be an array');
    if (!Array.isArray(humanComments)) fail(where, '`humanComments` must be an array');

    predictions.forEach((p, i) => validateLocated(p, `${where} predictions[${i}]`));
    humanComments.forEach((c, i) => validateLocated(c, `${where} humanComments[${i}]`));
    adjudications.forEach((a, i) => {
        validateLocated(a, `${where} adjudications[${i}]`);
        if (!VERDICTS.has(a.verdict)) {
            fail(`${where} adjudications[${i}]`, `verdict must be one of ${[...VERDICTS].join(' | ')}, got ${JSON.stringify(a.verdict)}`);
        }
    });

    return {
        id: raw.id,
        url: raw.url ?? null,
        predictions,
        adjudications,
        humanComments,
        // P1-7: carried through rather than projected away. The benchmark report
        // needs the case's shape (`prData`), what the run recorded
        // (`runStats`, `manifest`, `retention`), and whether the run could read
        // the whole change (`incomplete`). Dropping them here is why corpus
        // coverage, stage retention and the incompleteness rate all read as
        // empty no matter what the runner wrote.
        ...(raw.prData !== undefined ? { prData: raw.prData } : {}),
        ...(raw.runStats !== undefined ? { runStats: raw.runStats } : {}),
        ...(raw.manifest !== undefined ? { manifest: raw.manifest } : {}),
        ...(raw.retention !== undefined ? { retention: raw.retention } : {}),
        ...(raw.incomplete !== undefined ? { incomplete: raw.incomplete } : {}),
        ...(raw.productPath !== undefined ? { productPath: raw.productPath } : {}),
        ...(raw.categories !== undefined ? { categories: raw.categories } : {}),
    };
}

/**
 * Validate a whole corpus.
 * @param {unknown} raw - parsed JSON: either an array of cases or {cases: [...]}
 * @returns {Array<object>}
 */
export function validateCorpus(raw) {
    const cases = Array.isArray(raw) ? raw : raw?.cases;
    if (!Array.isArray(cases)) {
        throw new Error('Eval corpus invalid: expected an array of cases, or { "cases": [...] }');
    }
    if (cases.length === 0) {
        throw new Error('Eval corpus is empty — scoring nothing would report a vacuous pass');
    }

    const seen = new Set();
    return cases.map((c, i) => {
        const validated = validateCase(c, i);
        if (seen.has(validated.id)) {
            throw new Error(`Eval corpus invalid: duplicate case id "${validated.id}"`);
        }
        seen.add(validated.id);
        return validated;
    });
}

export default { validateCorpus, validateCase };

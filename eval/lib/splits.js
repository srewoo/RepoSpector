/**
 * splits — held-out repositories and repeated runs. P1-7.
 *
 * Two ways a benchmark number flatters the thing it measures, and neither is
 * visible in the number itself.
 *
 * TUNING ON THE TEST SET. Thresholds get adjusted until the corpus scores well,
 * and the corpus is then reported as evidence about repositories nobody tuned
 * against. Splitting BY REPOSITORY rather than by case is what makes the
 * held-out half meaningful: two merge requests from the same repo share its
 * conventions, its idioms and often its defects, so a case-level split leaks
 * the answer across the boundary.
 *
 * SINGLE-RUN VARIANCE. Models are not deterministic at temperature > 0, and a
 * review pipeline that fans out over chunks compounds that. One run of one
 * corpus produces a number with no error bar of its own, and the Wilson
 * interval on it describes sampling error only — not the variance you would see
 * by running the identical configuration again. Repeated runs measure that
 * second kind, and when it is large the first kind was never the binding
 * constraint.
 */

/** Repository identity for a case: explicit, else derived from its URL. */
export function repoOf(kase) {
    if (kase?.repo) return String(kase.repo);
    const url = String(kase?.url ?? '');
    // https://host/owner/name/pull/1  ·  https://host/group/sub/name/-/merge_requests/1
    const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests)\//);
    if (m) return m[1];
    // Fall back to the case id's first segment, which is how the corpora name
    // cases (`owner-repo-123`). Never `null`: an unattributable case would
    // silently join whichever side of the split it was iterated into.
    return String(kase?.id ?? 'unknown').split(/[#@]/)[0];
}

/** Deterministic 0..1 from a string, so a split is reproducible without a seed file. */
function hashUnit(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < String(text).length; i++) {
        h ^= String(text).charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 0xffffffff;
}

/**
 * Split cases into a tuning set and a held-out set, BY REPOSITORY.
 *
 * @param {Array} cases
 * @param {{holdout?: number, salt?: string}} [options] `holdout` is the share of
 *   REPOSITORIES held out, not of cases — the two differ whenever repositories
 *   contribute unequal numbers of merge requests, and the count that matters
 *   for leakage is the first.
 * @returns {{tune: Array, holdout: Array, repos: {tune: string[], holdout: string[]}}}
 */
export function splitByRepository(cases = [], { holdout = 0.3, salt = 'repospector' } = {}) {
    const repos = [...new Set(cases.map(repoOf))].sort();
    const heldOut = new Set(repos.filter((r) => hashUnit(`${salt}:${r}`) < holdout));

    // Never hold out everything, and never hold out nothing: either makes the
    // split a no-op that still reads as a split.
    if (repos.length > 1 && (heldOut.size === 0 || heldOut.size === repos.length)) {
        heldOut.clear();
        heldOut.add(repos[repos.length - 1]);
    }

    return {
        tune: cases.filter((c) => !heldOut.has(repoOf(c))),
        holdout: cases.filter((c) => heldOut.has(repoOf(c))),
        repos: {
            tune: repos.filter((r) => !heldOut.has(r)),
            holdout: [...heldOut],
        },
    };
}

/**
 * Confirm a split leaks no repository across the boundary.
 *
 * Cheap, and worth asserting rather than assuming: a split that shares a
 * repository is not a held-out set, and it fails silently — the numbers still
 * come out, they are just wrong in the flattering direction.
 */
export function splitLeaks(split) {
    const tune = new Set(split.tune.map(repoOf));
    return [...new Set(split.holdout.map(repoOf))].filter((r) => tune.has(r));
}

/**
 * Summarise the same metric measured across repeated runs of one configuration.
 *
 * Reports the SPREAD, not just the mean, because the spread is the finding: a
 * 4-point swing between identical runs means a 2-point improvement is noise,
 * and no confidence interval computed within a single run will tell you that.
 *
 * @param {number[]} values one metric, one entry per run
 */
export function runVariance(values = []) {
    // `Number(null)` and `Number('')` are both 0 and both finite, so coercing
    // first turns "this run produced no figure" into "this run scored zero" —
    // which drags the mean down and widens the spread with data that does not
    // exist. Reject the empty forms before touching Number().
    const xs = values
        .filter((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
        .map(Number);
    if (xs.length === 0) return { runs: 0, mean: null, min: null, max: null, spread: null, stdev: null };

    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    const variance = xs.reduce((a, b) => a + ((b - mean) ** 2), 0) / xs.length;

    return { runs: xs.length, mean, min, max, spread: max - min, stdev: Math.sqrt(variance) };
}

/**
 * Is an observed difference larger than the noise between identical runs?
 *
 * Deliberately blunt. A change smaller than the observed run-to-run spread is
 * not evidence of anything, and saying so is more useful than a p-value nobody
 * will compute correctly on four runs.
 */
export function describeRunVariance(variance, delta = null) {
    if (!variance || variance.runs === 0) return 'No repeated runs: this figure has no measured run-to-run variance.';
    if (variance.runs === 1) return 'One run: the interval below is sampling error only, not run-to-run variance.';

    const base = `${variance.runs} runs, spread ${(variance.spread * 100).toFixed(1)}pp `
        + `(σ ${(variance.stdev * 100).toFixed(1)}pp)`;
    if (delta == null) return base;

    return Math.abs(delta) <= variance.spread
        ? `${base} — a change of ${(delta * 100).toFixed(1)}pp is WITHIN that spread and is not evidence`
        : `${base} — a change of ${(delta * 100).toFixed(1)}pp exceeds that spread`;
}

export default { repoOf, splitByRepository, splitLeaks, runVariance, describeRunVariance };

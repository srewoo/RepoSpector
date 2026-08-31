/**
 * SkipRuleEngine — classifies a PR/MR before any LLM spend.
 *
 * Goal: cheap
 * short-circuit verdicts for changes that don't deserve a full review,
 * plus DEFER signals for transient blockers (merge conflict, failing CI).
 *
 * Returns one of:
 *   { action: 'REVIEW' }                        → run the normal pipeline
 *   { action: 'REVIEW', partial: {...} }        → review, but only a bounded subset
 *   { action: 'AUTO_VERDICT', verdict, reason, classification }
 *   { action: 'SKIP',         reason }          → don't review at all
 *   { action: 'DEFER',        reason }          → ask user to retry later
 *
 * A note on how aggressive these rules should be. Every SKIP is a review the user
 * asked for and did not get, and the only signal they get back is a one-line note.
 * Two of the original rules were too blunt for that trade:
 *
 *   - OVERSIZED returned SKIP, so a large refactor — the change most in need of a
 *     second pair of eyes — produced nothing at all, even though `MRChunker`
 *     exists precisely to review large MRs in pieces. It now returns REVIEW with a
 *     `partial` budget, so the reviewer covers the highest-signal files and SAYS
 *     what it left out.
 *   - TESTS_ONLY auto-APPROVED without reading anything, which also meant the
 *     dedicated `test-quality` finder lens could never run: the gate fired before
 *     it. Wrong assertions and silently-disabled tests are real defects, so a
 *     test-only change is now reviewed like any other.
 */

import { VERDICT } from './reviewSchema.js';

// Tunables — all overridable per-call.
export const DEFAULT_THRESHOLDS = Object.freeze({
    OVERSIZED_FILES: 200,
    OVERSIZED_LOC: 5000,
    /** How many files an oversized MR still gets reviewed, highest-signal first. */
    PARTIAL_MAX_FILES: 60,
    /** …and the LOC ceiling for that subset. */
    PARTIAL_MAX_LOC: 4000,
    DOC_PATH_RE: /(^|\/)(docs?|README|CHANGELOG|LICENSE|\.md$|\.mdx$|\.rst$|\.txt$)/i,
    TEST_PATH_RE: /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.go$|_spec\.rb$/i,
    CI_PATH_RE: /(^|\/)(\.github|\.gitlab|\.circleci|\.azure-pipelines|Jenkinsfile|\.travis|\.drone)/i,
    DEP_PATH_RE: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Pipfile(\.lock)?|requirements[^/]*\.txt|poetry\.lock|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|Cargo\.(toml|lock))$/i,
    BINARY_EXT_RE: /\.(png|jpe?g|gif|ico|svg|webp|bmp|tiff|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|class|jar|wasm|woff2?|ttf|eot|mp[34]|mov|webm|psd|sketch|fig)$/i,
    BOT_LOGIN_RE: /(\[bot\]$|^dependabot|^renovate|^greenkeeper|^snyk-bot|^github-actions)/i,
    /**
     * A PURE revert, as git itself writes it: `Revert "<original subject>"`.
     *
     * This was `/^revert\b/i`, which also swallowed "Revert the cache layer and add
     * a bounded LRU" — a revert plus new code, where the new code is exactly what
     * needs reviewing. Requiring the quoted original subject is what distinguishes
     * a mechanical `git revert` from a hand-written change that mentions one.
     */
    REVERT_TITLE_RE: /^revert(?:\s+"[^"]+"|\s+'[^']+'|:?\s+commit\s+[0-9a-f]{7,40})\s*$/i,
});

/**
 * Classify the change set into one of:
 *   DOCS_ONLY | TESTS_ONLY | CI_ONLY | DEPS_ONLY | BINARY_ONLY | CODE_CHANGES | EMPTY
 *
 * Order matters: more specific buckets win. CODE_CHANGES is the fallback.
 */
export function classifyChanges(files, thresholds = DEFAULT_THRESHOLDS) {
    if (!Array.isArray(files) || files.length === 0) return 'EMPTY';

    let docs = 0, tests = 0, ci = 0, deps = 0, binaries = 0, code = 0;

    for (const f of files) {
        const path = f?.filename ?? f?.path ?? f?.new_path ?? '';
        if (!path) continue;

        if (thresholds.BINARY_EXT_RE.test(path)) { binaries++; continue; }
        if (thresholds.DEP_PATH_RE.test(path))   { deps++; continue; }
        if (thresholds.CI_PATH_RE.test(path))    { ci++; continue; }
        if (thresholds.TEST_PATH_RE.test(path))  { tests++; continue; }
        if (thresholds.DOC_PATH_RE.test(path))   { docs++; continue; }
        code++;
    }

    if (code > 0) return 'CODE_CHANGES';
    if (docs > 0 && tests === 0 && ci === 0 && deps === 0) return 'DOCS_ONLY';
    if (tests > 0 && docs === 0 && ci === 0 && deps === 0) return 'TESTS_ONLY';
    if (ci > 0 && deps === 0) return 'CI_ONLY';
    if (deps > 0) return 'DEPS_ONLY';
    if (binaries > 0) return 'BINARY_ONLY';
    return 'CODE_CHANGES';
}

/**
 * Rank and cap the files of an oversized MR so the reviewer spends its budget on
 * the parts most likely to contain a defect worth blocking on.
 *
 * Ordering signals, in priority order:
 *   1. non-generated before generated / vendored / lockfile-ish
 *   2. non-test source before tests (tests are still eligible, just later)
 *   3. larger change first — more added lines, more surface for a defect
 *
 * Deliberately deterministic: two runs over the same MR must pick the same files,
 * or the review changes shape between pushes for no reason the author can see.
 *
 * @param {Array<object>} files
 * @param {object} t - thresholds
 * @returns {Array<object>}
 */
export function selectFilesForPartialReview(files, t = DEFAULT_THRESHOLDS) {
    const GENERATED_RE = /(^|\/)(vendor|third_party|node_modules|dist|build|generated|__generated__)\//i;
    const GENERATED_NAME_RE = /\.(min\.js|min\.css|pb\.go|pb\.cc)$|_pb2\.py$|\.snap$/i;

    const scored = (files ?? []).map((f, index) => {
        const path = f?.filename ?? f?.path ?? f?.new_path ?? '';
        const churn = (f?.additions ?? 0) + (f?.deletions ?? 0);
        return {
            file: f,
            index,                                        // stable tiebreak
            generated: GENERATED_RE.test(path) || GENERATED_NAME_RE.test(path) ? 1 : 0,
            test: t.TEST_PATH_RE.test(path) ? 1 : 0,
            churn,
        };
    });

    scored.sort((a, b) =>
        a.generated - b.generated
        || a.test - b.test
        || b.churn - a.churn
        || a.index - b.index,
    );

    const out = [];
    let loc = 0;
    for (const s of scored) {
        if (out.length >= t.PARTIAL_MAX_FILES) break;
        // Always take at least one file, even a pathologically large one, so an MR
        // of a single 10k-line file is not silently reduced to nothing.
        if (out.length > 0 && loc + s.churn > t.PARTIAL_MAX_LOC) continue;
        out.push(s.file);
        loc += s.churn;
    }
    return out;
}

/**
 * Main entry. `pr` is the unified PR shape from PullRequestService
 * (works for GitHub PR + GitLab MR — both already normalised).
 */
export function evaluateSkipRules(pr, opts = {}) {
    const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    if (!pr || typeof pr !== 'object') {
        return { action: 'REVIEW' }; // be permissive if we don't know
    }

    // 1. Closed / merged → nothing actionable.
    const state = String(pr.state ?? '').toLowerCase();
    if (state === 'closed' || pr.merged === true || state === 'merged') {
        return { action: 'SKIP', reason: 'pr_closed_or_merged' };
    }

    // 2. Draft → no review until ready.
    if (pr.isDraft === true) {
        return { action: 'SKIP', reason: 'draft_pr' };
    }

    // 3. Bot-authored → no review.
    const login = pr.author?.login ?? pr.author?.username ?? '';
    if (login && t.BOT_LOGIN_RE.test(login)) {
        return { action: 'SKIP', reason: `bot_author:${login}` };
    }

    // 4. Pure revert → low value, skip.
    if (typeof pr.title === 'string' && t.REVERT_TITLE_RE.test(pr.title.trim())) {
        return { action: 'SKIP', reason: 'revert_pr' };
    }

    // 5. Merge conflict → DEFER (re-run after rebase).
    //    `mergeable` is true/false/null on GitHub; null = "checking" → don't defer.
    if (pr.mergeable === false) {
        return { action: 'DEFER', reason: 'merge_conflict' };
    }

    // 6. Failing pipeline → DEFER (re-run after fix).
    const pipeline = String(pr.pipelineStatus ?? pr.ciStatus ?? '').toLowerCase();
    if (pipeline && /^(failed|failing|error)$/.test(pipeline)) {
        return { action: 'DEFER', reason: 'failing_pipeline' };
    }

    // 7. Oversized → still review, but only a bounded, prioritised subset.
    //
    // `opts.allowPartialReview: false` restores the old hard SKIP for callers that
    // genuinely cannot afford a large run (e.g. an automated hook on a metered key).
    const files = pr.files ?? [];
    const fileCount = files.length;
    const loc = (pr.stats?.additions ?? 0) + (pr.stats?.deletions ?? 0);
    const oversized = fileCount > t.OVERSIZED_FILES || loc > t.OVERSIZED_LOC;

    // 8. Classify. Needed before the oversized branch so an oversized docs-only or
    //    binary-only MR still short-circuits instead of paying for a partial review
    //    of files nobody wants reviewed.
    const classification = classifyChanges(files, t);

    if (oversized && classification === 'CODE_CHANGES') {
        if (opts.allowPartialReview === false) {
            return { action: 'SKIP', reason: `oversized:files=${fileCount},loc=${loc}` };
        }
        const selected = selectFilesForPartialReview(files, t);
        return {
            action: 'REVIEW',
            classification,
            partial: {
                reason: `oversized:files=${fileCount},loc=${loc}`,
                totalFiles: fileCount,
                totalLoc: loc,
                reviewedFiles: selected.map(f => f.filename ?? f.path ?? f.new_path),
                skippedFileCount: fileCount - selected.length,
            },
        };
    }

    switch (classification) {
        case 'EMPTY':
            return { action: 'SKIP', reason: 'no_files_changed' };
        case 'BINARY_ONLY':
            return {
                action: 'AUTO_VERDICT',
                verdict: VERDICT.NEEDS_DISCUSSION,
                reason: 'binary_only_changes',
                classification,
            };
        case 'DOCS_ONLY':
            return {
                action: 'AUTO_VERDICT',
                verdict: VERDICT.APPROVE,
                reason: classification.toLowerCase(),
                classification,
            };
        case 'TESTS_ONLY':
            // Reviewed like any other change — see the module note. Tagged so the
            // prompt layer can bias toward assertion correctness and skipped tests.
            return { action: 'REVIEW', classification, testsOnly: true };
        case 'CI_ONLY':
        case 'DEPS_ONLY':
            return {
                action: 'AUTO_VERDICT',
                verdict: VERDICT.NEEDS_DISCUSSION,
                reason: classification.toLowerCase(),
                classification,
            };
        case 'CODE_CHANGES':
        default:
            return { action: 'REVIEW', classification };
    }
}

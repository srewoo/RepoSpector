/**
 * SkipRuleEngine — classifies a PR/MR before any LLM spend.
 *
 * Inspired by Bastion's docs/Skip_Rules_And_Edge_Cases.md. Goal: cheap
 * short-circuit verdicts for changes that don't deserve a full review,
 * plus DEFER signals for transient blockers (merge conflict, failing CI).
 *
 * Returns one of:
 *   { action: 'REVIEW' }                        → run the normal pipeline
 *   { action: 'AUTO_VERDICT', verdict, reason, classification }
 *   { action: 'SKIP',         reason }          → don't review at all
 *   { action: 'DEFER',        reason }          → ask user to retry later
 */

import { VERDICT } from './reviewSchema.js';

// Tunables — all overridable per-call.
export const DEFAULT_THRESHOLDS = Object.freeze({
    OVERSIZED_FILES: 200,
    OVERSIZED_LOC: 5000,
    DOC_PATH_RE: /(^|\/)(docs?|README|CHANGELOG|LICENSE|\.md$|\.mdx$|\.rst$|\.txt$)/i,
    TEST_PATH_RE: /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.go$|_spec\.rb$/i,
    CI_PATH_RE: /(^|\/)(\.github|\.gitlab|\.circleci|\.azure-pipelines|Jenkinsfile|\.travis|\.drone)/i,
    DEP_PATH_RE: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Pipfile(\.lock)?|requirements[^/]*\.txt|poetry\.lock|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|Cargo\.(toml|lock))$/i,
    BINARY_EXT_RE: /\.(png|jpe?g|gif|ico|svg|webp|bmp|tiff|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|class|jar|wasm|woff2?|ttf|eot|mp[34]|mov|webm|psd|sketch|fig)$/i,
    BOT_LOGIN_RE: /(\[bot\]$|^dependabot|^renovate|^greenkeeper|^snyk-bot|^github-actions)/i,
    REVERT_TITLE_RE: /^revert\b/i,
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

    // 7. Oversized → SKIP (better as separate small PRs).
    const files = pr.files ?? [];
    const fileCount = files.length;
    const loc = (pr.stats?.additions ?? 0) + (pr.stats?.deletions ?? 0);
    if (fileCount > t.OVERSIZED_FILES || loc > t.OVERSIZED_LOC) {
        return {
            action: 'SKIP',
            reason: `oversized:files=${fileCount},loc=${loc}`,
        };
    }

    // 8. Classify and route to auto-verdict.
    const classification = classifyChanges(files, t);
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
        case 'TESTS_ONLY':
            return {
                action: 'AUTO_VERDICT',
                verdict: VERDICT.APPROVE,
                reason: classification.toLowerCase(),
                classification,
            };
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

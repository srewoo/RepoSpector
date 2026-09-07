// Pure helper for building the `options` payload sent with a
// MULTI_PASS_PR_REVIEW request. Extracted out of App.jsx (a .jsx file that
// cannot be unit-tested in this repo) so the cache-bypass behaviour of the
// explicit "Re-run" action can be verified directly.
//
// Defect: neither the automatic/first-view review nor the explicit
// "Re-run"/"Re-run review" buttons ever set `bypassCache`, so a stale cached
// review (including one whose summary failed with a provider error) could
// never be escaped from the UI. The explicit re-run path must set
// `bypassCache: true`; the automatic/initial path must not, so a normal
// re-open of an unchanged PR still gets served from cache.
export function buildAnalyzePROptions(focusArea = null, { bypassCache = false } = {}) {
    const options = {
        focusAreas: focusArea ? [focusArea] : ['security', 'bugs', 'performance'],
        enableESLint: true,
        enableSemgrep: true,
        enableDependency: true
    };

    if (bypassCache) {
        options.bypassCache = true;
    }

    return options;
}

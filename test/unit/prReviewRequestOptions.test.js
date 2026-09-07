/**
 * Defect A: no UI control could bypass the 72h review cache. Both "Re-run"
 * affordances and the automatic/initial review call funnelled into the same
 * option-building code, none of which ever set `bypassCache`, so a stale
 * cached failure (e.g. a provider credit error) could never be escaped from
 * the popup UI.
 *
 * The option-building logic lives in a pure helper (extracted out of
 * App.jsx, which is a .jsx file and cannot be unit-tested in this repo) so
 * it can be asserted directly: the explicit re-run path must request
 * `bypassCache: true`, while the automatic/initial path must not, so a
 * normal re-open of an unchanged PR still gets served from cache.
 */

const { buildAnalyzePROptions } = require('../../src/popup/prReviewRequestOptions.js');

describe('buildAnalyzePROptions', () => {
    it('does not set bypassCache for the automatic/initial review path', () => {
        // Mirrors App.jsx's analyzePR() default call and the initial
        // "Analyze Pull Request" button, neither of which pass bypassCache.
        const options = buildAnalyzePROptions(null);

        expect(options.bypassCache).toBeUndefined();
    });

    it('does not set bypassCache when only a focus area is requested', () => {
        // Mirrors handlePRFocusArea(area) -> analyzePR(area).
        const options = buildAnalyzePROptions('security');

        expect(options.bypassCache).toBeUndefined();
        expect(options.focusAreas).toEqual(['security']);
    });

    it('sets bypassCache: true for the explicit re-run path', () => {
        // Mirrors handlePRRefresh() -> analyzePR(null, { bypassCache: true }),
        // which backs both "Re-run" buttons and "Try Again".
        const options = buildAnalyzePROptions(null, { bypassCache: true });

        expect(options.bypassCache).toBe(true);
    });
});

/**
 * `RANK` in src/utils/failLevel.js only understood the legacy/display
 * severity vocabulary (info/low/medium/high/critical). `toCanonicalFinding`
 * (src/services/reviewSchema.js) maps LLM severities `critical`/`high` onto
 * the CANONICAL severity `blocking` — and cross-repo findings are emitted
 * as canonical `blocking` directly. Because `blocking` was not in `RANK`,
 * `findingBlocks` treated it as `rank === undefined` and refused to block,
 * silently defeating the merge gate for exactly the highest-confidence
 * signal the pipeline produces.
 *
 * These tests drive the real module end-to-end through `findingBlocks` and
 * `decideFailure`.
 */
const { findingBlocks, decideFailure } = require('../../src/utils/failLevel.js');

describe('failLevel understands the canonical severity vocabulary', () => {
    it('a canonical "blocking" finding with blocking:true blocks at failLevel high', () => {
        const finding = { severity: 'blocking', blocking: true };
        expect(findingBlocks(finding, 'high')).toBe(true);
    });

    it('a canonical "blocking" finding with deterministic:true blocks at failLevel high', () => {
        const finding = { severity: 'blocking', deterministic: true };
        expect(findingBlocks(finding, 'high')).toBe(true);
    });

    it('a canonical "suggestion" does NOT block at high but DOES block at medium', () => {
        const finding = { severity: 'suggestion', blocking: true, deterministic: true };
        expect(findingBlocks(finding, 'high')).toBe(false);
        expect(findingBlocks(finding, 'medium')).toBe(true);
    });

    it('a canonical "nitpick" does not block at high', () => {
        const finding = { severity: 'nitpick', blocking: true, deterministic: true };
        expect(findingBlocks(finding, 'high')).toBe(false);
    });

    it('pre-existing legacy high/critical behaviour is unchanged', () => {
        expect(findingBlocks({ severity: 'high', blocking: true }, 'high')).toBe(true);
        expect(findingBlocks({ severity: 'critical', blocking: true }, 'high')).toBe(true);
        expect(findingBlocks({ severity: 'medium', blocking: true }, 'high')).toBe(false);
        expect(findingBlocks({ severity: 'low', deterministic: true }, 'medium')).toBe(false);
    });

    it('decideFailure returns REQUEST_CHANGES for a canonical blocking finding at failLevel high', () => {
        const finding = { severity: 'blocking', blocking: true };
        const d = decideFailure([finding], { failLevel: 'high' });
        expect(d.reviewEvent).toBe('REQUEST_CHANGES');
        expect(d.blocks).toBe(true);
    });
});

/**
 * The verdict a gated review reports, and what may be cached.
 *
 * The bug this guards against: a skip rule (draft, bot, revert, merge conflict,
 * failing pipeline, oversized) produces zero findings BY DESIGN, and the verdict
 * was derived from the finding count alone. So an unreviewed PR reported
 * `APPROVED` / `APPROVE`, the popup forwarded `reviewEvent` to the host verbatim,
 * and one click posted a real approval on code nothing had read. The result was
 * then cached as though it were a review.
 */

const { describeGateOutcome } = require('../../src/background/handlers/prReviewHandlers.js');
const { isCacheableReport } = require('../../src/services/ReviewCacheService.js');
const { countBlocking } = require('../../src/utils/findingsFlatten.js');

/** Shape the handler sees: adapter output with the orchestrator report attached. */
const withGate = (gate) => ({
    analysis: '',
    perFileFindings: [],
    gate,
    _orchestrated: { meta: { gate } },
});

describe('describeGateOutcome', () => {
    it('returns null for a genuine review, so the finding count governs', () => {
        expect(describeGateOutcome(withGate({ action: 'REVIEW', classification: 'CODE_CHANGES' }))).toBeNull();
    });

    it('returns null for the legacy engine path, which has no gate', () => {
        expect(describeGateOutcome({ analysis: '', perFileFindings: [] })).toBeNull();
        expect(describeGateOutcome(null)).toBeNull();
    });

    it.each([
        ['draft_pr'],
        ['bot_author:dependabot[bot]'],
        ['revert_pr'],
        ['pr_closed_or_merged'],
    ])('never approves a SKIP (%s)', (reason) => {
        const out = describeGateOutcome(withGate({ action: 'SKIP', reason }));
        expect(out.verdict).toBe('SKIPPED');
        expect(out.reviewEvent).toBe('COMMENT');
        expect(out.reason).toBe(reason);
    });

    it.each([['merge_conflict'], ['failing_pipeline']])('never approves a DEFER (%s)', (reason) => {
        const out = describeGateOutcome(withGate({ action: 'DEFER', reason }));
        expect(out.verdict).toBe('DEFERRED');
        expect(out.reviewEvent).toBe('COMMENT');
    });

    it('approves an AUTO_VERDICT only when the rule chose to approve', () => {
        const docs = describeGateOutcome(withGate({
            action: 'AUTO_VERDICT', verdict: 'APPROVE', reason: 'docs_only',
        }));
        expect(docs.verdict).toBe('APPROVED');
        expect(docs.reviewEvent).toBe('APPROVE');
    });

    it('does not approve a NEEDS_DISCUSSION auto-verdict', () => {
        const deps = describeGateOutcome(withGate({
            action: 'AUTO_VERDICT', verdict: 'NEEDS_DISCUSSION', reason: 'deps_only',
        }));
        expect(deps.verdict).toBe('NEEDS_DISCUSSION');
        expect(deps.reviewEvent).toBe('COMMENT');
    });

    it('falls back to NEEDS_DISCUSSION for an unrecognised action rather than approving', () => {
        const out = describeGateOutcome(withGate({ action: 'SOMETHING_NEW', reason: 'x' }));
        expect(out.reviewEvent).toBe('COMMENT');
        expect(out.verdict).toBe('NEEDS_DISCUSSION');
    });

    describe('partial review', () => {
        const partialGate = {
            action: 'REVIEW',
            classification: 'CODE_CHANGES',
            partial: {
                reason: 'oversized:files=300,loc=9000',
                totalFiles: 300,
                reviewedFiles: ['a.js', 'b.js'],
                skippedFileCount: 298,
            },
        };

        it('is a real review, but may never approve', () => {
            const out = describeGateOutcome(withGate(partialGate));
            expect(out.partialOnly).toBe(true);
            expect(out.reviewEvent).toBe('COMMENT');
            expect(out.verdict).toBe('NEEDS_DISCUSSION');
        });

        it('is not treated as partial when nothing was actually skipped', () => {
            const out = describeGateOutcome(withGate({
                action: 'REVIEW',
                partial: { reason: 'x', reviewedFiles: ['a.js'], skippedFileCount: 0 },
            }));
            expect(out).toBeNull();
        });
    });
});

describe('countBlocking understands every producer vocabulary', () => {
    it('counts legacy display severities', () => {
        expect(countBlocking([{ severity: 'critical' }, { severity: 'high' }])).toBe(2);
    });

    it('counts canonical `blocking` — cross-repo impact findings use it', () => {
        // A symbol this PR removed that a linked repo still calls is the highest
        // confidence blocking signal the pipeline has, and it could not flip the
        // verdict because only critical|high were counted.
        expect(countBlocking([{ severity: 'blocking' }])).toBe(1);
    });

    it('counts prose severities some provider paths emit', () => {
        expect(countBlocking([{ severity: 'error' }, { severity: 'blocker' }])).toBe(2);
    });

    it('is case-insensitive and ignores non-blocking severities', () => {
        expect(countBlocking([
            { severity: 'BLOCKING' },
            { severity: 'suggestion' },
            { severity: 'nitpick' },
            { severity: 'low' },
            {},
            null,
        ])).toBe(1);
    });
});

describe('isCacheableReport', () => {
    it('refuses a report whose verdict field is `reviewVerdict`', () => {
        // `store` only read `report.verdict`, but the handler stores `responseData`,
        // which names it `reviewVerdict` — so the guard read undefined for every
        // real call and gated runs WERE cached.
        expect(isCacheableReport({ reviewVerdict: 'SKIPPED' })).toBe(false);
        expect(isCacheableReport({ reviewVerdict: 'DEFERRED' })).toBe(false);
    });

    it('refuses anything flagged as skipped', () => {
        expect(isCacheableReport({ reviewVerdict: 'APPROVED', reviewSkipped: true })).toBe(false);
    });

    it('still refuses the canonical field', () => {
        expect(isCacheableReport({ verdict: 'SKIP' })).toBe(false);
        expect(isCacheableReport({ verdict: 'DEFER' })).toBe(false);
    });

    it('accepts a real review', () => {
        expect(isCacheableReport({ reviewVerdict: 'APPROVED', reviewSkipped: false })).toBe(true);
        expect(isCacheableReport({ reviewVerdict: 'CHANGES_REQUESTED' })).toBe(true);
    });

    it('refuses a null report', () => {
        expect(isCacheableReport(null)).toBe(false);
    });
});

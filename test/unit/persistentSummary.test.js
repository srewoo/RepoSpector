/**
 * One summary per PR, updated in place. The properties that matter: it must never
 * edit a comment it does not own, and it must not destroy what the review said
 * about an earlier commit — replies are attached to that text.
 */

const {
    SUMMARY_MARKER,
    MAX_HISTORY,
    isSummaryComment,
    findSummaryComment,
    buildSummaryBody,
    planSummary,
} = require('../../src/utils/persistentSummary.js');

describe('ownership', () => {
    it('recognises only its own comment', () => {
        expect(isSummaryComment(`${SUMMARY_MARKER}\nReview`)).toBe(true);
        expect(isSummaryComment('A human wrote this')).toBe(false);
        // Not confused by our OTHER markers.
        expect(isSummaryComment('<!-- repospector-finding-v1 -->\nInline note')).toBe(false);
        expect(isSummaryComment('<!-- repospector-feedback-v1 -->')).toBe(false);
    });

    it('is safe on junk', () => {
        for (const junk of [null, undefined, 42, {}, '']) {
            expect(isSummaryComment(junk)).toBe(false);
        }
    });

    it('never matches a human comment, even from the same account', () => {
        // The token may be a human's PAT that also writes ordinary comments;
        // "the most recent comment by this user" would eventually overwrite one.
        const comments = [
            { id: 1, body: 'LGTM' },
            { id: 2, body: 'One more thing…' },
        ];
        expect(findSummaryComment(comments)).toBeNull();
    });

    it('takes the OLDEST summary when two somehow exist', () => {
        // Replies are attached to the older one; consolidating into it preserves
        // the conversation.
        const comments = [
            { id: 10, body: `${SUMMARY_MARKER}\nfirst` },
            { id: 20, body: `${SUMMARY_MARKER}\nsecond` },
        ];
        expect(findSummaryComment(comments).id).toBe(10);
    });

    it('handles an empty comment list', () => {
        expect(findSummaryComment([])).toBeNull();
        expect(findSummaryComment()).toBeNull();
    });
});

describe('planSummary', () => {
    it('creates a marked comment when none exists', () => {
        const plan = planSummary({ summary: 'Found 2 issues', comments: [], headSha: 'abcdef1234' });
        expect(plan.action).toBe('create');
        expect(plan.commentId).toBeNull();
        expect(plan.body).toContain(SUMMARY_MARKER);
        expect(plan.body).toContain('Found 2 issues');
        expect(plan.body).toContain('abcdef12');   // short sha, for traceability
    });

    it('updates the existing comment instead of adding another', () => {
        const plan = planSummary({
            summary: 'Now 1 issue',
            comments: [{ id: 77, body: `${SUMMARY_MARKER}\nFound 2 issues` }],
            headSha: 'ffff0000',
        });
        expect(plan.action).toBe('update');
        expect(plan.commentId).toBe(77);
        expect(plan.body).toContain('Now 1 issue');
    });

    it('keeps the previous review, collapsed', () => {
        // Replacing it outright leaves anyone reading replies responding to text
        // that no longer exists.
        const plan = planSummary({
            summary: 'Second review',
            comments: [{ id: 1, body: `${SUMMARY_MARKER}\nFirst review\n\n<sub>Reviewed \`aaaa1111\`</sub>` }],
            headSha: 'bbbb2222',
        });

        expect(plan.body).toContain('Second review');
        expect(plan.body).toContain('<details><summary>Previous review');
        expect(plan.body).toContain('First review');
        // Labelled by the commit it described, so the history reads as commits.
        expect(plan.body).toContain('aaaa1111');
    });

    it('does not nest history blocks on every update', () => {
        let body = `${SUMMARY_MARKER}\nrev1`;
        for (let i = 2; i <= 4; i++) {
            body = planSummary({
                summary: `rev${i}`,
                comments: [{ id: 1, body }],
                headSha: `sha${i}`,
            }).body;
        }
        // One <details> per kept revision, not exponential growth.
        const blocks = (body.match(/<details>/g) || []).length;
        expect(blocks).toBeLessThanOrEqual(MAX_HISTORY);
        expect(body).toContain('rev4');
    });

    it('caps history and says how many it dropped', () => {
        let body = `${SUMMARY_MARKER}\nrev1`;
        for (let i = 2; i <= 8; i++) {
            body = planSummary({ summary: `rev${i}`, comments: [{ id: 1, body }] }).body;
        }
        expect((body.match(/<details>/g) || []).length).toBeLessThanOrEqual(MAX_HISTORY);
        expect(body).toMatch(/older revision\(s\) not kept/);
    });

    it('truncates an enormous previous body rather than growing forever', () => {
        const huge = `${SUMMARY_MARKER}\n${'x'.repeat(20_000)}`;
        const plan = planSummary({ summary: 'new', comments: [{ id: 1, body: huge }] });
        expect(plan.body).toContain('…truncated.');
        expect(plan.body.length).toBeLessThan(20_000);
    });

    it('reproduces the old behaviour when disabled', () => {
        const plan = planSummary({
            summary: 'A review',
            comments: [{ id: 1, body: `${SUMMARY_MARKER}\nold` }],
            enabled: false,
        });
        expect(plan.action).toBe('create');
        // No marker: an unmarked comment is never picked up for editing later,
        // which is exactly what "a comment per run" means.
        expect(plan.body).not.toContain(SUMMARY_MARKER);
        expect(plan.body).toBe('A review');
    });

    it('works with no sha and no history', () => {
        const plan = planSummary({ summary: 'Review' });
        expect(plan.action).toBe('create');
        expect(plan.body).toContain('Review');
        expect(plan.body).not.toContain('Reviewed `');
    });
});

describe('buildSummaryBody', () => {
    it('always leads with the marker so the comment is findable', () => {
        expect(buildSummaryBody({ summary: 'x' }).startsWith(SUMMARY_MARKER)).toBe(true);
    });

    it('stamps the reviewed commit', () => {
        const body = buildSummaryBody({ summary: 'x', headSha: 'deadbeefcafe' });
        expect(body).toContain('Reviewed `deadbeef`');
        expect(body).toMatch(/UTC/);
    });

    it('tolerates an empty summary', () => {
        expect(buildSummaryBody({}).trim()).toBe(SUMMARY_MARKER);
    });
});

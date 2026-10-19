const { partitionForPosting, renderPolicyNote } = require('../../src/utils/reviewPostingPolicy.js');

const f = (over = {}) => ({ file: 'src/a.js', line: 10, severity: 'high', title: 'Something', ...over });
const unscored = { status: 'unscored', reason: 'budget' };
const scored = { status: 'scored', score: 90 };

describe('partitionForPosting — unscored findings', () => {
    it('never posts an unscored finding inline; it goes to notVerified', () => {
        const res = partitionForPosting([f({ rubric: unscored }), f({ line: 11, rubric: scored })]);
        expect(res.inline.map((x) => x.line)).toEqual([11]);
        expect(res.notVerified.map((x) => x.line)).toEqual([10]);
        expect(res.stats.notVerified).toBe(1);
    });

    it('keeps unscored out of inline even with blockingOnlyInline: false', () => {
        const res = partitionForPosting([f({ rubric: unscored })], { blockingOnlyInline: false });
        expect(res.inline).toHaveLength(0);
        expect(res.notVerified).toHaveLength(1);
    });

    it('still applies the severity floor to unscored findings', () => {
        const res = partitionForPosting([f({ severity: 'low', rubric: unscored })], { severityThreshold: 'high' });
        expect(res.notVerified).toHaveLength(0);
        expect(res.stats.droppedBySeverityFloor).toBe(1);
    });

    it('returns an empty notVerified list when everything was scored', () => {
        expect(partitionForPosting([f({ rubric: scored })]).notVerified).toEqual([]);
    });
});

describe('renderPolicyNote — not verified', () => {
    it('mentions the not-verified count', () => {
        expect(renderPolicyNote({ notVerified: 2 })).toMatch(/2 not verified by the rubric check/);
    });
});

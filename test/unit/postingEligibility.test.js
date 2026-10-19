const { checkPostingEligibility } = require('../../src/utils/postingEligibility.js');

const pr = (over = {}) => ({
    state: 'open', isDraft: false, merged: false, mergeable: true,
    author: { login: 'alice' }, title: 'Add search', stats: { additions: 1, deletions: 0 },
    files: [{ filename: 'src/a.js', patch: '@@ -1,0 +1,1 @@\n+x', additions: 1, deletions: 0 }],
    ...over,
});

describe('checkPostingEligibility', () => {
    it('allows an open PR', () => {
        expect(checkPostingEligibility(pr())).toEqual({ eligible: true, reason: null, gateReason: null });
    });

    it('refuses a draft', () => {
        const r = checkPostingEligibility(pr({ isDraft: true }));
        expect(r.eligible).toBe(false);
        expect(r.gateReason).toBe('draft_pr');
        expect(r.reason).toMatch(/draft/i);
    });

    it('refuses a closed PR', () => {
        const r = checkPostingEligibility(pr({ state: 'closed' }));
        expect(r.eligible).toBe(false);
        expect(r.reason).toMatch(/closed/);
    });

    it('refuses a merged GitHub PR (state closed + merged flag)', () => {
        const r = checkPostingEligibility(pr({ state: 'closed', merged: true }));
        expect(r.eligible).toBe(false);
        expect(r.reason).toMatch(/merged/);
    });

    it('refuses a merged GitLab MR (state merged)', () => {
        const r = checkPostingEligibility(pr({ state: 'merged', merged: true }));
        expect(r.reason).toMatch(/merged/);
    });

    it('does not refuse for review-time skip reasons (bot author, no files)', () => {
        expect(checkPostingEligibility(pr({ author: { login: 'renovate[bot]' } })).eligible).toBe(true);
        expect(checkPostingEligibility(pr({ files: [] })).eligible).toBe(true);
    });

    it('fails open, flagged unknown, when the PR could not be re-fetched', () => {
        expect(checkPostingEligibility(null)).toEqual({ eligible: true, reason: null, gateReason: null, unknown: true });
    });
});

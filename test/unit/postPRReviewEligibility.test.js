/**
 * POST_PR_REVIEW re-checks eligibility on the freshly fetched PR (spec §4.3)
 * and refuses closed / merged / draft without posting anything.
 */
const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

function makeSvc(prOverrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        updatePRServiceTokens: jest.fn(async () => {}),
        getStoredSettings: jest.fn(async () => ({ provider: 'openai', model: 'm', apiKey: 'k' })),
        isTestAutomationPR: jest.fn(() => false),
        llmService: { streamChat: jest.fn(), setCallBudget: jest.fn(), clearCallBudget: jest.fn() },
        pullRequestService: {
            fetchPullRequest: jest.fn(async () => ({
                title: 't', state: 'open', isDraft: false, merged: false, author: { login: 'a' },
                stats: { additions: 0, deletions: 0 }, files: [], url: 'u', headSha: null,
                ...prOverrides,
            })),
            formatReviewSummary: jest.fn(() => 'summary'),
            formatInlineComments: jest.fn(() => []),
            fetchIssueComments: jest.fn(async () => []),
            generateFixSuggestions: jest.fn(async () => {}),
            postReview: jest.fn(async () => ({ commentsPosted: 0, commentsAttempted: 0, hasSummary: true })),
        },
    };
}

const post = async (svc) => {
    const send = jest.fn();
    await createPrReviewHandlers(svc).POST_PR_REVIEW(
        { data: { prUrl: 'https://github.com/o/r/pull/1', analysisResult: { findings: [] }, options: {} } },
        send,
    );
    return send.mock.calls[0][0];
};

describe('POST_PR_REVIEW eligibility re-check', () => {
    it.each([
        ['merged', { state: 'closed', merged: true }, /merged/],
        ['closed', { state: 'closed' }, /closed/],
        ['draft', { isDraft: true }, /draft/i],
    ])('refuses a %s PR and posts nothing', async (_label, over, msg) => {
        const svc = makeSvc(over);
        const res = await post(svc);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(msg);
        expect(res.data.ineligible).toBe(true);
        expect(svc.pullRequestService.postReview).not.toHaveBeenCalled();
    });

    it('posts on an open PR', async () => {
        const svc = makeSvc();
        const res = await post(svc);
        expect(res.success).toBe(true);
        expect(svc.pullRequestService.postReview).toHaveBeenCalledTimes(1);
    });
});

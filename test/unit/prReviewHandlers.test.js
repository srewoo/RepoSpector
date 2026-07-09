/**
 * Tests for the extracted PR-review handlers
 * (src/background/handlers/prReviewHandlers.js). Uses a mock svc so the
 * handlers are exercised without instantiating the whole BackgroundService.
 * The multi-pass pipeline is intentionally NOT fully exercised — we cover the
 * exported shape plus validation/error paths on a handful of handlers.
 */

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        updatePRServiceTokens: jest.fn(async () => {}),
        getStoredSettings: jest.fn(async () => ({ provider: 'openai', model: 'm', apiKey: 'k' })),
        isTestAutomationPR: jest.fn(() => false),
        _estimateCost: jest.fn(() => 0),
        _runHunkPrompt: jest.fn(async () => 'hunk-text'),
        telemetry: { record: jest.fn(async () => {}) },
        ragService: {
            retrieveContext: jest.fn(async () => null),
            getRepositoryDocumentation: jest.fn(async () => ({ found: false })),
        },
        adaptiveLearningService: { getDismissedRulesSummary: jest.fn(async () => []) },
        staticAnalysisService: { analyzeFile: jest.fn(async () => ({ ok: true })) },
        pullRequestService: {
            fetchPullRequest: jest.fn(async () => ({
                title: 't', description: '', state: 'open', author: { login: 'a' },
                stats: { additions: 1, deletions: 0 }, files: [], url: 'u', branches: {},
            })),
            generatePRSummary: jest.fn(() => ({})),
            getHighRiskFiles: jest.fn(() => []),
            postReview: jest.fn(async () => ({ commentsPosted: 1, hasSummary: true })),
        },
        llmService: { streamChat: jest.fn(async () => ({ content: 'analysis BLOCKING: 0' })) },
        ...overrides,
    };
}

describe('prReviewHandlers', () => {
    it('should register the expected message types', () => {
        const h = createPrReviewHandlers(makeSvc());
        expect(Object.keys(h).sort()).toEqual([
            'ANALYZE_PR_WITH_STATIC_ANALYSIS',
            'ANALYZE_PULL_REQUEST',
            'EXPLAIN_HUNK',
            'FETCH_FULL_FILE',
            'GET_PR_SUMMARY',
            'MULTI_PASS_PR_REVIEW',
            'POST_INLINE_COMMENT',
            'POST_PR_REVIEW',
            'REVIEW_TEST_AUTOMATION',
            'RUN_STATIC_ANALYSIS',
            'SECURITY_REVIEW_PR',
            'SUGGEST_FIX_HUNK',
        ]);
    });

    it('exposes the three content-script handlers as {fn, allowContentScript:true}', () => {
        const h = createPrReviewHandlers(makeSvc());
        for (const key of ['EXPLAIN_HUNK', 'SUGGEST_FIX_HUNK', 'POST_INLINE_COMMENT']) {
            expect(typeof h[key]).toBe('object');
            expect(typeof h[key].fn).toBe('function');
            expect(h[key].allowContentScript).toBe(true);
        }
    });

    it('all non-content-script entries are plain functions', () => {
        const h = createPrReviewHandlers(makeSvc());
        for (const key of ['ANALYZE_PULL_REQUEST', 'GET_PR_SUMMARY', 'RUN_STATIC_ANALYSIS', 'POST_PR_REVIEW']) {
            expect(typeof h[key]).toBe('function');
        }
    });

    describe('validation paths', () => {
        it('ANALYZE_PULL_REQUEST rejects when prUrl is missing', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).ANALYZE_PULL_REQUEST({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR URL is required' });
            expect(svc.pullRequestService.fetchPullRequest).not.toHaveBeenCalled();
        });

        it('GET_PR_SUMMARY rejects when prUrl is missing', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).GET_PR_SUMMARY({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR URL is required' });
        });

        it('RUN_STATIC_ANALYSIS rejects when code is missing', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).RUN_STATIC_ANALYSIS({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Code is required' });
            expect(svc.staticAnalysisService.analyzeFile).not.toHaveBeenCalled();
        });

        it('POST_INLINE_COMMENT requires prUrl, path, line, body', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).POST_INLINE_COMMENT.fn({ payload: { prUrl: 'u' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'prUrl, path, line, body all required' });
            expect(svc.pullRequestService.postReview).not.toHaveBeenCalled();
        });

        it('EXPLAIN_HUNK requires code', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).EXPLAIN_HUNK.fn({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'code is required' });
            expect(svc._runHunkPrompt).not.toHaveBeenCalled();
        });
    });

    describe('happy + error paths', () => {
        it('RUN_STATIC_ANALYSIS returns service result', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).RUN_STATIC_ANALYSIS({ data: { code: 'x' } }, send);
            expect(svc.staticAnalysisService.analyzeFile).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: true, data: { ok: true } });
        });

        it('EXPLAIN_HUNK returns text from _runHunkPrompt', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createPrReviewHandlers(svc).EXPLAIN_HUNK.fn({ payload: { code: 'diff' } }, send);
            expect(svc._runHunkPrompt).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: true, text: 'hunk-text' });
        });

        it('reports errors via errorHandler + getErrorMessage', async () => {
            const svc = makeSvc();
            svc.staticAnalysisService.analyzeFile = jest.fn(async () => { throw new Error('boom'); });
            const send = jest.fn();
            await createPrReviewHandlers(svc).RUN_STATIC_ANALYSIS({ data: { code: 'x' } }, send);
            expect(svc.errorHandler.logError).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'boom' });
        });
    });
});

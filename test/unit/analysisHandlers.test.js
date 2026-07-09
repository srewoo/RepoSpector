/**
 * Tests for the extracted analysis / learning / compliance / metrics handlers
 * (src/background/handlers/analysisHandlers.js), using a mock svc.
 */

const { createAnalysisHandlers } = require('../../src/background/handlers/analysisHandlers.js');

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        getStoredSettings: jest.fn(async () => ({ githubToken: 'g', gitlabToken: 'l' })),
        adaptiveLearningService: {
            recordAction: jest.fn(async () => {}),
            getStats: jest.fn(async () => ({ dismissed: 2 })),
        },
        telemetry: { recordDismissal: jest.fn(async () => {}) },
        customRulesService: { fetchConfig: jest.fn(async () => ({ rules: [] })) },
        pullRequestService: { fetchPullRequest: jest.fn(async () => ({ title: 'PR', body: 'x' })) },
        prComplianceChecker: {
            check: jest.fn(() => ({
                grade: 'A', score: 100, passed: 1, failed: 0,
                results: [{ passed: true, severity: 'info', message: 'Has description' }],
            })),
        },
        reviewMetricsService: { getMetrics: jest.fn(async () => ({ totalReviews: 0 })) },
        codeGraphPipeline: { graph: null },
        ...overrides,
    };
}

describe('analysisHandlers', () => {
    it('registers the expected message types', () => {
        expect(Object.keys(createAnalysisHandlers(makeSvc())).sort()).toEqual([
            'ANALYZE_DEAD_CODE', 'ANALYZE_IMPACT', 'CHECK_PR_COMPLIANCE',
            'FETCH_CUSTOM_CONFIG', 'GET_LEARNING_STATS', 'GET_REVIEW_METRICS',
            'RECORD_FINDING_ACTION',
        ]);
    });

    describe('RECORD_FINDING_ACTION', () => {
        it('validates required fields', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).RECORD_FINDING_ACTION({ data: { ruleId: 'r' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'ruleId, repoId, and action are required' });
        });

        it('records the action and bumps telemetry on dismissal', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createAnalysisHandlers(svc).RECORD_FINDING_ACTION(
                { data: { ruleId: 'r', repoId: 'o/r', action: 'dismissed' } }, send);
            expect(svc.adaptiveLearningService.recordAction).toHaveBeenCalled();
            expect(svc.telemetry.recordDismissal).toHaveBeenCalledWith('pr_review');
            expect(send).toHaveBeenCalledWith({ success: true });
        });

        it('does not bump telemetry for non-dismissals', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createAnalysisHandlers(svc).RECORD_FINDING_ACTION(
                { data: { ruleId: 'r', repoId: 'o/r', action: 'resolved' } }, send);
            expect(svc.telemetry.recordDismissal).not.toHaveBeenCalled();
        });
    });

    describe('GET_LEARNING_STATS', () => {
        it('requires repoId', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).GET_LEARNING_STATS({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'repoId is required' });
        });

        it('returns stats', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).GET_LEARNING_STATS({ data: { repoId: 'o/r' } }, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: { dismissed: 2 } });
        });
    });

    describe('ANALYZE_IMPACT / ANALYZE_DEAD_CODE', () => {
        it('errors clearly when the knowledge graph is unavailable', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).ANALYZE_IMPACT({ data: { targetName: 'foo', repoId: 'r' } }, send);
            expect(send.mock.calls[0][0].success).toBe(false);
            expect(send.mock.calls[0][0].error).toMatch(/Knowledge graph not available/);
        });

        it('ANALYZE_IMPACT requires a target name', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).ANALYZE_IMPACT({ data: { repoId: 'r' } }, send);
            expect(send.mock.calls[0][0].error).toMatch(/Target function\/class name is required/);
        });
    });

    describe('CHECK_PR_COMPLIANCE', () => {
        it('requires a PR URL', async () => {
            const send = jest.fn();
            await createAnalysisHandlers(makeSvc()).CHECK_PR_COMPLIANCE({ data: {} }, send);
            expect(send.mock.calls[0][0].error).toMatch(/PR URL is required/);
        });

        it('runs the checker and returns a formatted report', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createAnalysisHandlers(svc).CHECK_PR_COMPLIANCE({ data: { prUrl: 'https://github.com/o/r/pull/1' } }, send);
            expect(svc.pullRequestService.fetchPullRequest).toHaveBeenCalled();
            expect(svc.prComplianceChecker.check).toHaveBeenCalled();
            const arg = send.mock.calls[0][0];
            expect(arg.success).toBe(true);
            expect(typeof arg.data.response).toBe('string');
        });
    });

    describe('GET_REVIEW_METRICS', () => {
        it('returns metrics with a formatted response', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createAnalysisHandlers(svc).GET_REVIEW_METRICS({ data: { repoId: 'o/r' } }, send);
            expect(svc.reviewMetricsService.getMetrics).toHaveBeenCalledWith('o/r', 30);
            expect(send.mock.calls[0][0].success).toBe(true);
        });
    });
});

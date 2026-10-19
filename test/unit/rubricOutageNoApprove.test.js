/**
 * C1: a rubric outage must never turn into a posted APPROVE.
 *
 * Unscored findings are non-blocking by design (they are never posted inline),
 * so when EVERY model finding is unscored — a bad lightModel, a provider error,
 * budget exhaustion — the finding-count verdict would be "Clean review" /
 * APPROVE. The handler must treat the unscored set as an unavailable required
 * check, so the completeness contract withdraws the approval.
 *
 * Drives the real handleMultiPassPRReview (same heavy-mock convention as
 * missingTestFindingReview.test.js); the engine returns one model finding and
 * every model call fails, so the rubric stage leaves it unscored.
 */

jest.mock('../../src/services/MultiPassReviewEngine.js', () => {
    return {
        MultiPassReviewEngine: jest.fn().mockImplementation(() => ({
            execute: jest.fn(async () => ({
                analysis: 'ok',
                verdict: null,
                gate: null,
                perFileFindings: [{
                    file: 'src/pricing.js',
                    findings: [{
                        severity: 'high', line: 2, title: 'Price doubles instead of adding tax',
                        description: 'x * 2 is wrong for the tax rule', confidence: 0.95, category: 'bug', evidence: 'return x * 2;',
                    }],
                }],
                tokenUsage: { input: 0, output: 0 },
            })),
        })),
    };
});

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

function makeSvc(prOverrides = {}) {
    const prData = {
        title: 't', description: '', state: 'open', author: { login: 'a' },
        stats: { additions: 3, deletions: 0 },
        files: [
            {
                filename: 'src/pricing.js',
                patch: '@@ -1,2 +1,4 @@\n+function calculateWidgetPrice(x) {\n+  return x * 2;\n+}',
            },
            {
                filename: 'test/pricing.test.js',
                patch: '@@ -1,1 +1,2 @@\n+it("unrelated behaviour", () => {});',
            },
        ],
        url: 'https://github.com/acme/widgets/pull/1',
        headSha: 'sha1',
        ...prOverrides,
        branches: { source: 'feature', targetRepo: 'acme/widgets' },
    };

    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        updatePRServiceTokens: jest.fn(async () => {}),
        getStoredSettings: jest.fn(async () => ({
            provider: 'openai', model: 'm', apiKey: 'k',
            reviewSettings: {
                fullFileContext: false,
                enableFeedbackFooter: false,
                reviewCache: false,
                incrementalReview: false,
                graphContext: false,
            },
        })),
        isTestAutomationPR: jest.fn(() => false),
        codeGraphPipeline: { hasGraph: jest.fn(async () => true), updateGraph: jest.fn(async () => {}) },
        ragService: {
            init: jest.fn(async () => {}),
            vectorStore: { isIndexed: jest.fn(async () => true) },
            retrieveContext: jest.fn(async () => null),
            getRepositoryDocumentation: jest.fn(async () => ({ found: false })),
        },
        _fetchRAGContextForMultiPass: jest.fn(async () => null),
        _fetchRepoDocForMultiPass: jest.fn(async () => null),
        adaptiveLearningService: { getDismissedRulesSummary: jest.fn(async () => []) },
        staticAnalysisService: {
            analyzeFile: jest.fn(async () => ({ ok: true })),
            analyzePullRequest: jest.fn(async () => ({ findings: [], totalFindings: 0, riskScore: 0, summary: '' })),
        },
        customRulesService: { fetchConfig: jest.fn(async () => null) },
        prScoreCache: new Map(),
        pullRequestService: {
            fetchPullRequest: jest.fn(async () => ({ ...prData })),
            parsePullRequestUrl: jest.fn(() => null),
            fetchReviewComments: jest.fn(async () => []),
            generatePRSummary: jest.fn(() => ({})),
            getHighRiskFiles: jest.fn(() => []),
            postReview: jest.fn(async () => ({ commentsPosted: 1, hasSummary: true })),
            estimateReviewEffort: jest.fn(() => 1),
        },
        llmService: { streamChat: jest.fn(async () => { throw new Error('provider down'); }) },
        reviewMetricsService: { recordReview: jest.fn(async () => {}) },
        telemetry: { record: jest.fn(async () => {}) },
        githubService: { getRepoId: jest.fn(() => 'acme/widgets') },
        gitlabService: { getRepoId: jest.fn(() => 'acme/widgets') },
    };
}

async function runMultiPassReview(svc) {
    const send = jest.fn();
    await createPrReviewHandlers(svc).MULTI_PASS_PR_REVIEW(
        {
            data: {
                prUrl: 'https://github.com/acme/widgets/pull/1',
                options: {
                    orchestratedReview: false,
                    fetchFullFiles: false,
                    multiFinder: false,
                    verifyFindings: false,
                    llmRefutation: false,
                    autofix: false,
                    scoreFindings: false,
                    teamConventions: false,
                    graphContext: false,
                    repoExploration: false,
                    priorFindings: false,
                },
            },
        },
        send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    return send.mock.calls[0][0];
}

describe('handleMultiPassPRReview — rubric outage', () => {
    it('does not approve when every model finding is unscored, and reads as partial', async () => {
        const response = await runMultiPassReview(makeSvc());
        expect(response.success).toBe(true);
        const d = response.data;
        expect(d.reviewQuality.notVerified).toBeGreaterThan(0);
        expect(d.reviewEvent).not.toBe('APPROVE');
        expect(d.reviewVerdict).not.toBe('APPROVED');
        expect(d.incomplete).toBe(true);
        expect(d.incompleteReasons.join(' ')).toMatch(/rubric scorer/);
        expect(d.analysis).not.toMatch(/Clean review/);
        expect(d.analysis).toMatch(/Partial review/);
    });
});

// I2: a pipeline status that could not be read is a check that did not run.
describe('handleMultiPassPRReview — unreadable pipeline status', () => {
    it('lists pipelineStatus under "Checks that did not run" with the reason', async () => {
        const response = await runMultiPassReview(makeSvc({ pipelineStatusReason: 'checks_unreadable: HTTP 403' }));
        const d = response.data;
        expect(d.reviewQuality.lensReport).toContainEqual(
            { lens: 'pipelineStatus', status: 'not-run', reason: 'checks_unreadable: HTTP 403' },
        );
        expect(d.analysis).toMatch(/### Checks that did not run[\s\S]*`pipelineStatus` — checks_unreadable: HTTP 403/);
    });

    it('adds nothing when the checks were readable', async () => {
        const d = (await runMultiPassReview(makeSvc())).data;
        expect(d.reviewQuality.lensReport.some((r) => r.lens === 'pipelineStatus')).toBe(false);
    });
});

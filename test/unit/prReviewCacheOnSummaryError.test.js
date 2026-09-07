/**
 * Defect B: a review whose AI summary failed with a provider error (e.g. "no
 * credits remaining") was still cached as a normal successful review. The
 * store guard at src/background/handlers/prReviewHandlers.js only checked
 * `reviewSettings.reviewCache !== false && cacheableRun` — a transient
 * provider credit/credential failure sets `aiSummaryError` but is neither of
 * those, so it got cached for the full 72h TTL with no way for the user to
 * clear it short of switching providers AND finding the (undocumented)
 * cache-bypass path.
 *
 * This drives the real handleMultiPassPRReview end-to-end (mirroring the
 * heavy-mock convention used by prReviewHandlersConventions.test.js) with
 * every optional/expensive pipeline stage turned off, so the only thing left
 * to vary is whether the LLM call used for the summary succeeds or fails,
 * and asserts on ReviewCacheService.store's call count.
 */

jest.mock('../../src/services/MultiPassReviewEngine.js', () => {
    return {
        MultiPassReviewEngine: jest.fn().mockImplementation(() => ({
            execute: jest.fn(async () => ({
                analysis: 'ok',
                verdict: null,
                gate: null,
                perFileFindings: [],
                tokenUsage: { input: 0, output: 0 },
            })),
        })),
    };
});

jest.mock('../../src/services/ReviewCacheService.js', () => {
    const actual = jest.requireActual('../../src/services/ReviewCacheService.js');
    return {
        ...actual,
        ReviewCacheService: jest.fn().mockImplementation(() => ({
            lookup: jest.fn(async () => ({ status: actual.CACHE_STATUS.MISS, entry: null, ageMs: null })),
            store: jest.fn(async () => {}),
        })),
    };
});

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');
const { ReviewCacheService } = require('../../src/services/ReviewCacheService.js');

function makeSvc({ summaryThrows = false } = {}) {
    const prData = {
        title: 't', description: '', state: 'open', author: { login: 'a' },
        stats: { additions: 1, deletions: 0 },
        files: [{ filename: 'a.js', patch: '@@ -1 +1 @@\n-old\n+new' }],
        url: 'https://github.com/acme/widgets/pull/1',
        headSha: 'sha1',
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
                reviewCache: true, // must be enabled to reach the store call
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
        llmService: {
            // The only stage left enabled that calls the LLM is the summary
            // generation. summaryThrows flips it between a real credit/auth
            // failure (aiSummaryError gets set) and a normal success.
            streamChat: jest.fn(async () => {
                if (summaryThrows) {
                    throw new Error('OpenAI API error (429): "You have no credits remaining" "credit_balance_exhausted"');
                }
                return { content: 'A short PR summary.' };
            }),
        },
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

describe('handleMultiPassPRReview — does not cache a run whose summary failed', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('does NOT store the review when aiSummaryError is set (e.g. a provider credit failure)', async () => {
        const svc = makeSvc({ summaryThrows: true });

        const response = await runMultiPassReview(svc);

        expect(response.success).toBe(true);
        expect(response.data.aiSummaryError).toMatch(/no credits remaining/);

        const cacheInstance = ReviewCacheService.mock.results[0].value;
        expect(cacheInstance.store).not.toHaveBeenCalled();
    });

    it('still stores the review when the summary succeeds (aiSummaryError is null)', async () => {
        const svc = makeSvc({ summaryThrows: false });

        const response = await runMultiPassReview(svc);

        expect(response.success).toBe(true);
        expect(response.data.aiSummaryError).toBeNull();

        const cacheInstance = ReviewCacheService.mock.results[0].value;
        expect(cacheInstance.store).toHaveBeenCalledTimes(1);
    });
});

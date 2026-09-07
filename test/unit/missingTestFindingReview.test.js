/**
 * Regression test for the missing-test finder being silently swallowed.
 *
 * findMissingTests() (src/utils/missingTestFinder.js) emits findings with
 * `severity: 'low'`, and the precision gate (src/utils/genuineProblemGate.js)
 * rejects EVERY low-severity finding with reason `non-problem-severity`
 * unless it is an authoritative external fact (secrets/dependency/osv/eol) or
 * a breaking cross-repo fact — a missing-test finding is neither, so before
 * the fix it never survived `filterGenuineProblems` inside
 * handleMultiPassPRReview and never reached a reviewer.
 *
 * This drives the real handleMultiPassPRReview end-to-end (mirroring the
 * heavy-mock convention used by prReviewHandlersConventions.test.js and
 * prReviewCacheOnSummaryError.test.js) with every optional/expensive pipeline
 * stage turned off, over a PR diff that adds an exported function and a test
 * file that does not mention it — exactly the case findMissingTests() flags.
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

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

function makeSvc() {
    const prData = {
        title: 't', description: '', state: 'open', author: { login: 'a' },
        stats: { additions: 3, deletions: 0 },
        files: [
            {
                filename: 'src/pricing.js',
                patch: '@@ -1,2 +1,4 @@\n+export function calculateWidgetPrice(x) {\n+  return x * 2;\n+}',
            },
            {
                filename: 'test/pricing.test.js',
                patch: '@@ -1,1 +1,2 @@\n+it("unrelated behaviour", () => {});',
            },
        ],
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
        llmService: { streamChat: jest.fn(async () => ({ content: 'A short PR summary.' })) },
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

describe('handleMultiPassPRReview — missing-test findings reach the reviewer', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('a missing-test finding survives the full review and appears in verifiedFindings', async () => {
        const svc = makeSvc();

        const response = await runMultiPassReview(svc);

        expect(response.success).toBe(true);
        const found = response.data.verifiedFindings.find(f => f.rule === 'static/missing-test');
        expect(found).toBeDefined();
        expect(found).toMatchObject({
            file: 'src/pricing.js',
            source: 'static',
            severity: 'low',
        });
        expect(found.title).toMatch(/calculateWidgetPrice/);
    });
});

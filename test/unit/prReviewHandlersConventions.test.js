/**
 * Integration coverage for the review path's convention-mining block inside
 * handleMultiPassPRReview (src/background/handlers/prReviewHandlers.js).
 *
 * Before this file, `prewarm`/`inFlight`/`awaitWarm` were exercised only in
 * isolation (ConventionMinerPrewarm.test.js) and `conventionBlock` had NO test
 * at all — reverting the whole three-branch block would have kept the suite
 * green. These tests close that gap:
 *   1. a cache hit renders a convention block and does NOT start a mine
 *   2. a mine in flight is awaited and its rules reach the block
 *   3. the deadline expiring falls back to no block without hanging
 *   4. a sentinel "insufficient history" result does NOT render a block AND
 *      DOES start a prewarm (the FIX 2 regression guard)
 *   5. nothing throws out of the block when the miner rejects
 *
 * `MultiPassReviewEngine.execute` is mocked to throw a recognizable sentinel
 * immediately after the convention block is built and handed to it — the
 * handler's single outer try/catch turns that into a normal error response,
 * so none of the (irrelevant, heavy) downstream pipeline needs mocking.
 * `CONVENTION_WARM_DEADLINE_MS` is mocked down to a few ms so the deadline
 * test does not hang for the real 15s.
 */

jest.mock('../../src/utils/constants.js', () => {
    const actual = jest.requireActual('../../src/utils/constants.js');
    return { ...actual, CONVENTION_WARM_DEADLINE_MS: 30 };
});

jest.mock('../../src/services/MultiPassReviewEngine.js', () => {
    return {
        MultiPassReviewEngine: jest.fn().mockImplementation(() => ({
            execute: jest.fn(async (prData, reviewContext) => {
                throw new Error(`__SENTINEL_STOP__:${JSON.stringify({
                    conventionBlock: reviewContext.conventionBlock,
                })}`);
            }),
        })),
    };
});

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');
const { ConventionMiner } = require('../../src/services/ConventionMiner.js');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function makeSvc(overrides = {}) {
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
            analyzePullRequest: jest.fn(async () => ({ findings: [], totalFindings: 0, riskScore: 0 })),
        },
        customRulesService: { fetchConfig: jest.fn(async () => null) },
        prScoreCache: new Map(),
        pullRequestService: {
            fetchPullRequest: jest.fn(async () => ({ ...prData })),
            parsePullRequestUrl: jest.fn(() => null), // short-circuits resolveLinkedIssue
            fetchReviewComments: jest.fn(async () => []),
            generatePRSummary: jest.fn(() => ({})),
            getHighRiskFiles: jest.fn(() => []),
            postReview: jest.fn(async () => ({ commentsPosted: 1, hasSummary: true })),
            estimateReviewEffort: jest.fn(() => 1),
        },
        llmService: { streamChat: jest.fn(async () => ({ content: 'analysis BLOCKING: 0' })) },
        githubService: { getRepoId: jest.fn(() => 'acme/widgets') },
        gitlabService: { getRepoId: jest.fn(() => 'acme/widgets') },
        ...overrides,
    };
}

/** Runs the handler and returns the sentinel payload (or the raw error message
 * if execute never fired — e.g. an early-return / cache path). */
async function runAndCapture(svc, options = {}) {
    const send = jest.fn();
    await createPrReviewHandlers(svc).MULTI_PASS_PR_REVIEW(
        { data: { prUrl: 'https://github.com/acme/widgets/pull/1', options: { orchestratedReview: false, ...options } } },
        send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    const response = send.mock.calls[0][0];
    expect(response.success).toBe(false); // sentinel always surfaces as an "error"
    const marker = '__SENTINEL_STOP__:';
    if (!response.error.startsWith(marker)) {
        throw new Error(`Handler did not reach the engine — got: ${response.error}`);
    }
    return JSON.parse(response.error.slice(marker.length));
}

describe('handleMultiPassPRReview — convention block integration', () => {
    beforeEach(() => {
        ConventionMiner.resetInFlight();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        ConventionMiner.resetInFlight();
    });

    it('renders a convention block from a cache hit and does NOT start a mine', async () => {
        const svc = makeSvc();
        const cached = { repoId: 'acme/widgets', rules: [{ rule: 'use tenant_id' }], stats: { rulesFound: 1 }, minedAt: Date.now() };
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockResolvedValue(cached);
        const prewarmSpy = jest.spyOn(ConventionMiner.prototype, 'prewarm');

        const { conventionBlock } = await runAndCapture(svc);

        expect(conventionBlock).toContain('use tenant_id');
        expect(prewarmSpy).not.toHaveBeenCalled();
    });

    it('awaits an in-flight mine and its rules reach the block', async () => {
        const svc = makeSvc();
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockResolvedValue(null);

        // Seed an in-flight mine directly via the real prewarm/registry so
        // ConventionMiner.inFlight()/awaitWarm() see it, exactly as a prior
        // index-time or page-detection trigger would have left it.
        const gate = deferred();
        const seedMiner = new ConventionMiner({ llmService: {} });
        jest.spyOn(seedMiner, 'getCached').mockResolvedValue(null);
        jest.spyOn(seedMiner, 'mine').mockReturnValue(gate.promise);
        seedMiner.prewarm('acme/widgets', async () => []);
        expect(ConventionMiner.inFlight('acme/widgets')).not.toBeNull();

        const runPromise = runAndCapture(svc);
        // Resolve the in-flight mine a few ms in — long enough that the
        // handler has certainly reached its inFlight() check and started
        // awaiting the SAME promise (a synchronous resolve here would race the
        // handler's own microtask chain and can settle-and-deregister the
        // in-flight entry before the handler ever looks at it) — but still
        // comfortably inside the mocked short deadline.
        setTimeout(() => {
            gate.resolve({ repoId: 'acme/widgets', rules: [{ rule: 'no console.log' }], stats: { rulesFound: 1 }, minedAt: Date.now() });
        }, 5);

        const { conventionBlock } = await runPromise;
        expect(conventionBlock).toContain('no console.log');
    });

    it('falls back to no block (without hanging) when the in-flight mine outlives the deadline', async () => {
        const svc = makeSvc();
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockResolvedValue(null);

        const seedMiner = new ConventionMiner({ llmService: {} });
        jest.spyOn(seedMiner, 'getCached').mockResolvedValue(null);
        jest.spyOn(seedMiner, 'mine').mockReturnValue(new Promise(() => {})); // never settles
        seedMiner.prewarm('acme/widgets', async () => []);

        const start = Date.now();
        const { conventionBlock } = await runAndCapture(svc);
        const elapsed = Date.now() - start;

        expect(conventionBlock).toBe('');
        // Bounded by the mocked short deadline, not the real 15s default.
        expect(elapsed).toBeLessThan(5000);
    });

    it('a sentinel "insufficient history" result renders no block and starts a prewarm', async () => {
        const svc = makeSvc();
        const sentinel = { repoId: 'acme/widgets', rules: [], stats: { reason: 'insufficient history' }, minedAt: Date.now() };
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockResolvedValue(sentinel);
        const prewarmSpy = jest.spyOn(ConventionMiner.prototype, 'prewarm').mockResolvedValue(null);

        const { conventionBlock } = await runAndCapture(svc);

        expect(conventionBlock).toBe('');
        expect(prewarmSpy).toHaveBeenCalledTimes(1);
        expect(prewarmSpy.mock.calls[0][0]).toBe('acme/widgets');
    });

    it('a genuinely cached zero-rule result does NOT trigger a re-mine', async () => {
        const svc = makeSvc();
        const cachedEmpty = { repoId: 'acme/widgets', rules: [], stats: { rulesFound: 0 }, minedAt: Date.now() };
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockResolvedValue(cachedEmpty);
        const prewarmSpy = jest.spyOn(ConventionMiner.prototype, 'prewarm');

        const { conventionBlock } = await runAndCapture(svc);

        expect(conventionBlock).toBe('');
        expect(prewarmSpy).not.toHaveBeenCalled();
    });

    it('does not throw out of the block when the miner rejects', async () => {
        const svc = makeSvc();
        jest.spyOn(ConventionMiner.prototype, 'getCached').mockRejectedValue(new Error('storage exploded'));

        const { conventionBlock } = await runAndCapture(svc);
        expect(conventionBlock).toBe('');
    });
});

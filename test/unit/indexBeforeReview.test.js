/**
 * Index-first ordering on the auto-review flow.
 *
 * The old flow was an either/or that never did both: with auto-review ON the
 * content script skipped index-on-open, and the review's own auto-index defaulted
 * to `'background'` — fire-and-forget. So the FIRST auto-review of any repo ran
 * against an EMPTY index: no retrieval, no code graph, a cold convention miner.
 * Turning the setting on made the first review worse-informed than leaving it off.
 *
 * These tests pin: indexing completes BEFORE the engine is called, the phase is
 * reported to the PR page, and an index failure degrades loudly rather than
 * silently producing a context-free review that looks like a normal one.
 */

const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

/** Ordered log of pipeline milestones, so ordering can be asserted. */
function harness({ indexed = false, indexThrows = null } = {}) {
    const order = [];
    const progress = [];

    const prData = {
        title: 'Add retry to the fetch helper',
        state: 'open',
        headSha: 'abc123',
        stats: { additions: 10, deletions: 2 },
        branches: { source: 'feature' },
        files: [{
            filename: 'src/fetch.js',
            status: 'modified',
            additions: 10,
            deletions: 2,
            language: 'javascript',
            patch: '@@ -1,2 +1,3 @@\n ctx\n+const r = await fetch(u);\n',
        }],
    };

    const svc = {
        updatePRServiceTokens: async () => {},
        getStoredSettings: async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: {
                // Keep the run cheap and deterministic: only the indexing ordering
                // is under test here.
                multiFinder: false, autofix: false, scoreFindings: false,
                teamConventions: false, graphContext: false, reviewCache: false,
                incrementalReview: false, fullFileContext: false,
                enableFeedbackFooter: false,
            },
        }),
        pullRequestService: {
            fetchPullRequest: async () => prData,
            enhanceFilesWithFullContent: async (_u, files) => files,
            estimateReviewEffort: () => ({ level: 'low' }),
            generatePRSummary: () => ({}),
            fetchReviewComments: async () => [],
        },
        prScoreCache: new Map(),
        staticAnalysisService: {
            analyzePullRequest: async () => ({ findings: [], summary: {}, riskScore: {}, totalFindings: 0 }),
            formatFindingsForPrompt: () => '',
        },
        customRulesService: { fetchConfig: async () => null },
        codeGraphPipeline: {
            hasGraph: async () => indexed,
            updateGraph: async () => { order.push('graph:update'); },
        },
        ragService: {
            init: async () => {},
            vectorStore: { isIndexed: async () => indexed },
            indexRepositoryIncremental: async () => { order.push('rag:index'); },
            retrieveContext: async () => { order.push('rag:retrieve'); return []; },
        },
        githubService: {
            getRepoId: () => 'acme/widgets',
            fetchRepositoryFiles: async (_url, onProg) => {
                if (indexThrows) throw new Error(indexThrows);
                order.push('fetchRepositoryFiles');
                onProg?.({ message: 'Downloaded 2/2 files', current: 2, total: 2 });
                return [{ path: 'src/fetch.js', content: 'export const f = 1;' }];
            },
        },
        gitlabService: { getRepoId: () => 'acme/widgets' },
        llmService: {
            streamChat: async () => {
                order.push('llm:call');
                return { content: JSON.stringify({ findings: [] }), usage: { input: 1, output: 1 } };
            },
        },
        isTestAutomationPR: () => false,
        adaptiveLearningService: { getDismissedRulesSummary: async () => [] },
        reviewMetricsService: { recordReview: async () => {} },
        telemetry: { record: async () => {} },
        findingCache: null,
        errorHandler: { logError: () => {} },
        getErrorMessage: (e) => e?.message || String(e),
        _estimateCost: () => 0,
        _fetchRAGContextForMultiPass: async () => { order.push('rag:retrieve'); return null; },
        _fetchRepoDocForMultiPass: async () => ({ found: false }),
    };

    global.chrome = {
        runtime: {
            id: 'test',
            sendMessage: (m) => { if (m?.type === 'PR_REVIEW_PROGRESS') progress.push(m.data); return Promise.resolve(); },
            getPlatformInfo: () => Promise.resolve({ os: 'mac' }),
        },
        tabs: {
            sendMessage: (_id, m) => {
                if (m?.type === 'PR_REVIEW_PROGRESS') progress.push({ ...m.data, _viaTab: true });
                return Promise.resolve();
            },
        },
    };

    return { svc, order, progress };
}

/** Run AUTO_REVIEW_PR the way the content script does, and resolve with the response. */
function runAutoReview(handlers, { tabId = 7 } = {}) {
    return new Promise((resolve) => {
        const entry = handlers.AUTO_REVIEW_PR;
        entry.fn(
            { type: 'AUTO_REVIEW_PR', data: { prUrl: 'https://github.com/acme/widgets/pull/1' } },
            resolve,
            { id: 'test', tab: { id: tabId, url: 'https://github.com/acme/widgets/pull/1' } },
        );
    });
}

describe('auto-review indexes before it reviews', () => {
    it('finishes indexing before the first LLM call', async () => {
        const { svc, order } = harness({ indexed: false });
        // Auto-review must be enabled for the handler to proceed.
        svc.getStoredSettings = async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: {
                autoReviewOnLoad: true,
                multiFinder: false, autofix: false, scoreFindings: false,
                teamConventions: false, graphContext: false, reviewCache: false,
                incrementalReview: false, fullFileContext: false,
                enableFeedbackFooter: false,
            },
        });

        const res = await runAutoReview(createPrReviewHandlers(svc));
        expect(res.success).toBe(true);

        const firstLlm = order.indexOf('llm:call');
        expect(firstLlm).toBeGreaterThan(-1);
        // Every indexing milestone lands before any model call.
        for (const step of ['fetchRepositoryFiles', 'rag:index', 'graph:update']) {
            const at = order.indexOf(step);
            expect(at).toBeGreaterThan(-1);
            expect(at).toBeLessThan(firstLlm);
        }
    });

    it('retrieves repo context only after indexing has finished', async () => {
        const { svc, order } = harness({ indexed: false });
        svc.getStoredSettings = async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: { autoReviewOnLoad: true, multiFinder: false, autofix: false, scoreFindings: false, teamConventions: false, graphContext: false, reviewCache: false, incrementalReview: false, fullFileContext: false },
        });

        await runAutoReview(createPrReviewHandlers(svc));
        // Retrieval against an empty index is the bug: it returned nothing and the
        // review silently proceeded context-free.
        expect(order.indexOf('rag:index')).toBeLessThan(order.indexOf('rag:retrieve'));
    });

    it('reports the indexing phase to the PR page, not just the popup', async () => {
        const { svc, progress } = harness({ indexed: false });
        svc.getStoredSettings = async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: { autoReviewOnLoad: true, multiFinder: false, autofix: false, scoreFindings: false, teamConventions: false, graphContext: false, reviewCache: false, incrementalReview: false, fullFileContext: false },
        });

        await runAutoReview(createPrReviewHandlers(svc));

        const indexing = progress.filter(p => p.step === 'indexing');
        expect(indexing.length).toBeGreaterThan(0);
        // A service worker's runtime.sendMessage does NOT reach content scripts, so
        // the on-page indicator needs the tabs.sendMessage transport.
        expect(indexing.some(p => p._viaTab)).toBe(true);
    });

    it('skips indexing when the repo is already indexed', async () => {
        const { svc, order } = harness({ indexed: true });
        svc.getStoredSettings = async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: { autoReviewOnLoad: true, multiFinder: false, autofix: false, scoreFindings: false, teamConventions: false, graphContext: false, reviewCache: false, incrementalReview: false, fullFileContext: false },
        });

        const res = await runAutoReview(createPrReviewHandlers(svc));
        expect(order).not.toContain('fetchRepositoryFiles');
        expect(res.data.reviewQuality.indexStatus).toBe('already-indexed');
        expect(res.data.reviewQuality.repoContextAvailable).toBe(true);
    });
});

describe('indexing failure degrades loudly', () => {
    it('still reviews, but records the failure and says so in the narrative', async () => {
        const { svc, order } = harness({ indexed: false, indexThrows: 'rate limited' });
        svc.getStoredSettings = async () => ({
            provider: 'openai', model: 'gpt-5', apiKey: 'k',
            reviewSettings: { autoReviewOnLoad: true, multiFinder: false, autofix: false, scoreFindings: false, teamConventions: false, graphContext: false, reviewCache: false, incrementalReview: false, fullFileContext: false },
        });

        const res = await runAutoReview(createPrReviewHandlers(svc));

        // Fail OPEN — a repo we cannot index still gets a patch-level review.
        expect(res.success).toBe(true);
        expect(order).toContain('llm:call');

        // …but never SILENTLY. "Found nothing about our conventions" must be
        // distinguishable from "had no idea what our conventions are".
        expect(res.data.reviewQuality.indexStatus).toBe('index-failed');
        expect(res.data.reviewQuality.indexError).toMatch(/rate limited/);
        expect(res.data.reviewQuality.repoContextAvailable).toBe(false);
        expect(res.data.analysis).toMatch(/without repository context/i);
    });
});

describe('the on-page indicator phase mapping', () => {
    // The REAL implementation, shared with the content script. Re-declaring the
    // mapping here would make this pass by construction and blind to drift.
    const { phaseLabelFor } = require('../../src/utils/reviewProgressLabel.js');

    it('shows Indexing with a count when one is available', () => {
        expect(phaseLabelFor({ step: 'indexing', current: 12, total: 40 })).toBe('Indexing 12/40');
        expect(phaseLabelFor({ step: 'indexing' })).toBe('Indexing');
        expect(phaseLabelFor({ phase: 'indexing' })).toBe('Indexing');
    });

    it('ignores a nonsensical count rather than rendering NaN', () => {
        expect(phaseLabelFor({ step: 'indexing', current: 3, total: 0 })).toBe('Indexing');
        expect(phaseLabelFor({ step: 'indexing', current: undefined, total: 40 })).toBe('Indexing');
    });

    it('falls back to Reviewing once indexing gives up', () => {
        expect(phaseLabelFor({ step: 'indexing', failed: true })).toBe('Reviewing');
    });

    it('labels a partial review as partial', () => {
        expect(phaseLabelFor({ step: 'partial_review' })).toBe('Reviewing (partial)');
    });

    it('maps the later pipeline phases', () => {
        expect(phaseLabelFor({ phase: 'verifying' })).toBe('Verifying');
        expect(phaseLabelFor({ phase: 'finding' })).toBe('Finding');
        expect(phaseLabelFor({ phase: 'scoring' })).toBe('Scoring');
        expect(phaseLabelFor({ step: 'deep_review' })).toBe('Reviewing');
    });

    it('returns null for events that do not change the phase', () => {
        expect(phaseLabelFor({ step: 'chunk_findings' })).toBeNull();
        expect(phaseLabelFor(null)).toBeNull();
        expect(phaseLabelFor('nope')).toBeNull();
    });
});

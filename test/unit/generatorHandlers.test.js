/**
 * Tests for the extracted generator handlers
 * (src/background/handlers/generatorHandlers.js). Uses a mock svc so the
 * handlers are exercised without instantiating the whole BackgroundService.
 */

const { createGeneratorHandlers } = require('../../src/background/handlers/generatorHandlers.js');

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        getModelId: jest.fn(() => 'gpt-4'),
        updatePRServiceTokens: jest.fn(async () => {}),
        getStoredSettings: jest.fn(async () => ({
            provider: 'openai', model: 'gpt-4', apiKey: 'sk-test'
        })),
        pullRequestService: {
            fetchPullRequest: jest.fn(async () => ({ title: 'PR', diff: 'x' })),
            updatePRDescription: jest.fn(async () => {}),
        },
        llmService: {
            streamChat: jest.fn(async () => ({ content: 'generated text' })),
            callLLM: jest.fn(async () => 'docs markdown'),
        },
        ragService: {
            retrieveContext: jest.fn(async () => [{ filePath: 'a.js', content: 'code' }]),
            getRepositoryDocumentation: jest.fn(async () => ({ found: false })),
        },
        codeGraphPipeline: { graph: null, hasGraphFor: () => false },
        contextAnalyzer: { extractRepoIdFromUrl: jest.fn(() => 'a/b') },
        ...overrides,
    };
}

describe('generatorHandlers', () => {
    it('should register the expected message types', () => {
        const h = createGeneratorHandlers(makeSvc());
        expect(Object.keys(h).sort()).toEqual([
            'GENERATE_CHANGELOG',
            'GENERATE_MERMAID_DIAGRAM',
            'GENERATE_PR_DESCRIPTION',
            'GENERATE_REPO_DIAGRAM',
            'GENERATE_REPO_DOCS',
            'GENERATE_REPO_INFO',
            'GENERATE_REPO_MINDMAP',
            'GENERATE_PR_TESTS',
        ].sort());
    });

    describe('GENERATE_PR_DESCRIPTION', () => {
        it('returns a description and does not apply to git by default', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_PR_DESCRIPTION(
                { payload: { prUrl: 'https://github.com/o/r/pull/1' } }, send);
            expect(svc.pullRequestService.updatePRDescription).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: { description: 'generated text', applied: false },
            });
        });

        it('applies to git when applyToGit is set', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_PR_DESCRIPTION(
                { payload: { prUrl: 'https://github.com/o/r/pull/1', applyToGit: true } }, send);
            expect(svc.pullRequestService.updatePRDescription).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: { description: 'generated text', applied: true },
            });
        });

        it('validates that prUrl is required', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_PR_DESCRIPTION({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR URL required' });
            expect(svc.pullRequestService.fetchPullRequest).not.toHaveBeenCalled();
        });

        it('reports errors via errorHandler + getErrorMessage', async () => {
            const svc = makeSvc();
            svc.pullRequestService.fetchPullRequest = jest.fn(async () => { throw new Error('boom'); });
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_PR_DESCRIPTION(
                { payload: { prUrl: 'https://github.com/o/r/pull/1' } }, send);
            expect(svc.errorHandler.logError).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'boom' });
        });
    });

    describe('GENERATE_CHANGELOG', () => {
        it('returns a changelog on the happy path', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_CHANGELOG(
                { payload: { prUrl: 'https://github.com/o/r/pull/1' } }, send);
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: { changelog: 'generated text' },
            });
        });

        it('validates that prUrl is required', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_CHANGELOG({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR URL required' });
        });
    });

    describe('GENERATE_REPO_DIAGRAM', () => {
        it('requires a repoId or url', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DIAGRAM({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Repository ID or URL required' });
        });

        it('errors when no indexed code is found', async () => {
            const svc = makeSvc();
            svc.ragService.retrieveContext = jest.fn(async () => []);
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DIAGRAM(
                { payload: { repoId: 'o/r' } }, send);
            expect(send).toHaveBeenCalledWith({
                success: false,
                error: 'No indexed code found. Please index the repository first.',
            });
        });

        it('resolves the repoId from a url via contextAnalyzer.extractRepoIdFromUrl (not the nonexistent svc.getRepoIdFromUrl)', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DIAGRAM(
                { payload: { url: 'https://github.com/a/b' } }, send);
            expect(svc.contextAnalyzer.extractRepoIdFromUrl).toHaveBeenCalledWith(
                'https://github.com/a/b', 'github');
            expect(svc.ragService.retrieveContext).toHaveBeenCalledWith('a/b', expect.any(String), 20);
        });

        it('errors when the repoId cannot be derived from the url', async () => {
            const svc = makeSvc({ contextAnalyzer: { extractRepoIdFromUrl: jest.fn(() => null) } });
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DIAGRAM(
                { payload: { url: 'not-a-url' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Repository ID or URL required' });
        });
    });

    describe('GENERATE_REPO_DOCS', () => {
        it('generates docs via callLLM on the happy path', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DOCS(
                { payload: { repoId: 'o/r', docType: 'overview' } }, send);
            expect(svc.llmService.callLLM).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: { repoInfoMarkdown: 'docs markdown', repoId: 'o/r', docType: 'overview' },
            });
        });

        it('errors when repoId is missing', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createGeneratorHandlers(svc).GENERATE_REPO_DOCS({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Repository ID is required' });
        });
    });

    describe('GENERATE_PR_TESTS', () => {
        it('requires a PR URL', async () => {
            const h = createGeneratorHandlers(makeSvc());
            const send = jest.fn();
            await h.GENERATE_PR_TESTS({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR URL required' });
        });

        it('fetches the PR, runs the generator and returns its result', async () => {
            const svc = makeSvc({
                pullRequestService: {
                    fetchPullRequest: jest.fn(async () => ({ files: [] })),
                },
                codeGraphPipeline: { graph: { nodeCount: 0 }, hasGraphFor: () => false },
            });
            const h = createGeneratorHandlers(svc);
            const send = jest.fn();
            await h.GENERATE_PR_TESTS({ data: { prUrl: 'https://github.com/a/b/pull/1' } }, send);
            expect(svc.pullRequestService.fetchPullRequest).toHaveBeenCalledWith('https://github.com/a/b/pull/1');
            const [[res]] = send.mock.calls;
            expect(res.success).toBe(true);
            expect(res.data).toMatchObject({ files: [], skipped: [{ reason: expect.stringMatching(/no untested/) }] });
        });

        it('never loads or reads the graph when the repoId cannot be derived', async () => {
            const pipeline = {
                graph: { nodeCount: 5 }, // already resident, e.g. from another repo
                hasGraph: jest.fn(async () => true),
                loadGraph: jest.fn(async () => {}),
                hasGraphFor: () => false, // resident graph belongs to a different repo
            };
            const svc = makeSvc({
                pullRequestService: {
                    fetchPullRequest: jest.fn(async () => ({ files: [] })),
                },
                codeGraphPipeline: pipeline,
                contextAnalyzer: { extractRepoIdFromUrl: jest.fn(() => null) },
            });
            const h = createGeneratorHandlers(svc);
            const send = jest.fn();
            await h.GENERATE_PR_TESTS({ data: { prUrl: 'https://github.com/a/b/pull/1' } }, send);
            expect(pipeline.hasGraph).not.toHaveBeenCalled();
            expect(pipeline.loadGraph).not.toHaveBeenCalled();
            const [[res]] = send.mock.calls;
            expect(res.success).toBe(true);
        });

        it('resolves the repoId via contextAnalyzer.extractRepoIdFromUrl, not the nonexistent svc.getRepoIdFromUrl', async () => {
            const pipeline = {
                graph: { nodeCount: 0 },
                loadedRepoId: null,
                hasGraph: jest.fn(async () => true),
                loadGraph: jest.fn(async (id) => { pipeline.graph = { nodeCount: 3 }; pipeline.loadedRepoId = id; }),
                hasGraphFor(repoId) {
                    return !!repoId && repoId === pipeline.loadedRepoId && pipeline.graph.nodeCount > 0;
                },
            };
            const svc = makeSvc({
                pullRequestService: {
                    fetchPullRequest: jest.fn(async () => ({ files: [] })),
                },
                codeGraphPipeline: pipeline,
            });
            const h = createGeneratorHandlers(svc);
            const send = jest.fn();
            await h.GENERATE_PR_TESTS({ data: { prUrl: 'https://github.com/a/b/pull/1' } }, send);
            expect(svc.contextAnalyzer.extractRepoIdFromUrl).toHaveBeenCalledWith(
                'https://github.com/a/b/pull/1', 'github');
            expect(pipeline.hasGraph).toHaveBeenCalledWith('a/b');
            expect(pipeline.loadGraph).toHaveBeenCalledWith('a/b');
        });
    });
});

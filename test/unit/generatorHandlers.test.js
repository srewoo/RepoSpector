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
        codeGraphPipeline: { graph: null },
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
        ]);
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
});

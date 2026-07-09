/**
 * Tests for the extracted repository-indexing handlers
 * (src/background/handlers/indexingHandlers.js). Uses a mock svc so the
 * handlers are exercised without instantiating the whole BackgroundService.
 */

const { createIndexingHandlers } = require('../../src/background/handlers/indexingHandlers.js');

function makeSvc(overrides = {}) {
    const vectorStore = {
        isIndexed: jest.fn(async () => true),
        clearRepo: jest.fn(async () => {}),
        getStats: jest.fn(async () => ({ totalChunks: 10 })),
        getAllRepoIds: jest.fn(async () => [{ repoId: 'org/repo' }]),
        getRepoStats: jest.fn(async () => ({ chunksCount: 5, filesCount: 2 })),
    };
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        ensureRagEmbeddingProvider: jest.fn(async () => {}),
        saveRepoMetadata: jest.fn(async () => {}),
        githubService: { getRepoId: jest.fn(() => 'org/repo'), fetchRepositoryFiles: jest.fn(async () => [{ path: 'a.js' }]) },
        gitlabService: { getRepoId: jest.fn(() => 'org/repo') },
        ragService: {
            init: jest.fn(async () => {}),
            vectorStore,
            indexRepositoryIncremental: jest.fn(async () => ({ chunksIndexed: 42 })),
        },
        codeGraphPipeline: {
            updateGraph: jest.fn(async () => ({ nodes: 3 })),
            deleteGraph: jest.fn(async () => {}),
        },
        ...overrides,
    };
}

beforeEach(() => {
    global.chrome = {
        tabs: { sendMessage: jest.fn(() => Promise.resolve()) },
        runtime: { sendMessage: jest.fn(() => Promise.resolve()) },
        storage: {
            local: {
                get: jest.fn(async () => ({ indexedReposMetadata: {} })),
                set: jest.fn(async () => {}),
            },
        },
    };
});

describe('indexingHandlers', () => {
    it('should register the expected message types', () => {
        const h = createIndexingHandlers(makeSvc());
        expect(Object.keys(h).sort()).toEqual([
            'CHECK_INDEX_STATUS', 'CLEAR_INDEX', 'DELETE_REPO_INDEX',
            'GET_INDEXED_REPOS', 'GET_INDEX_STATS', 'INDEX_REPOSITORY',
        ]);
    });

    describe('INDEX_REPOSITORY', () => {
        it('indexes a github repo and reports chunk counts', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            const sender = { tab: { id: 7 } };
            await createIndexingHandlers(svc).INDEX_REPOSITORY(
                { data: { url: 'https://github.com/org/repo' } }, send, sender);
            expect(svc.ragService.indexRepositoryIncremental).toHaveBeenCalled();
            expect(svc.saveRepoMetadata).toHaveBeenCalledWith(
                'org/repo', 'https://github.com/org/repo', 'github', expect.any(Object));
            expect(send).toHaveBeenCalledWith({
                success: true, repoId: 'org/repo', filesIndexed: 1, chunksIndexed: 42,
            });
        });

        it('rejects when url is missing', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).INDEX_REPOSITORY({ data: {} }, send, {});
            expect(send).toHaveBeenCalledWith({ success: false, error: 'URL is required' });
            expect(svc.ragService.indexRepositoryIncremental).not.toHaveBeenCalled();
        });

        it('rejects an unsupported platform', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).INDEX_REPOSITORY(
                { data: { url: 'https://bitbucket.org/org/repo' } }, send, {});
            expect(send).toHaveBeenCalledWith({
                success: false,
                error: 'Unsupported platform. Only GitHub and GitLab are supported.',
            });
        });
    });

    describe('CHECK_INDEX_STATUS', () => {
        it('returns indexed status for a repo', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).CHECK_INDEX_STATUS(
                { data: { url: 'https://github.com/org/repo' } }, send);
            expect(send).toHaveBeenCalledWith({ success: true, isIndexed: true, repoId: 'org/repo' });
        });

        it('validates url is required', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).CHECK_INDEX_STATUS({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'URL is required' });
        });

        it('reports errors via errorHandler + getErrorMessage', async () => {
            const svc = makeSvc();
            svc.ragService.vectorStore.isIndexed = jest.fn(async () => { throw new Error('boom'); });
            const send = jest.fn();
            await createIndexingHandlers(svc).CHECK_INDEX_STATUS(
                { data: { url: 'https://github.com/org/repo' } }, send);
            expect(svc.errorHandler.logError).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'boom' });
        });
    });

    describe('DELETE_REPO_INDEX', () => {
        it('clears the vector store, graph and metadata', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).DELETE_REPO_INDEX({ data: { repoId: 'org/repo' } }, send);
            expect(svc.ragService.vectorStore.clearRepo).toHaveBeenCalledWith('org/repo');
            expect(svc.codeGraphPipeline.deleteGraph).toHaveBeenCalledWith('org/repo');
            expect(chrome.storage.local.set).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: true, repoId: 'org/repo' });
        });

        it('requires a repoId', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).DELETE_REPO_INDEX({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Repository ID is required' });
        });
    });

    describe('GET_INDEXED_REPOS', () => {
        it('merges DB repos with stored metadata', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createIndexingHandlers(svc).GET_INDEXED_REPOS({}, send);
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: [{
                    repoId: 'org/repo',
                    platform: 'github',
                    url: 'https://github.com/org/repo',
                    indexedAt: null,
                    chunksCount: 5,
                    filesCount: 2,
                }],
            });
        });
    });
});

/**
 * RAG message handlers, extracted from background/index.js.
 *
 * These used to be module-scope functions closing over a `let ragService`
 * variable in index.js. They now live here behind a factory that receives the
 * BackgroundService instance and a mutable `ragState` holder (replacing the old
 * module-level variable), plus the service classes they instantiate. The
 * factory returns the handler map so index.js can register them with the router.
 */

/**
 * @param {object} opts
 * @param {object} opts.svc      - the BackgroundService instance
 * @param {{ service: any }} opts.ragState - mutable holder for the active RAGService
 * @param {Function} opts.RAGService
 * @param {Function} opts.GitHubService
 * @param {Function} opts.GitLabService
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createRagHandlers({ svc, ragState, RAGService, GitHubService, GitLabService }) {
    async function handleInitRag(message, sendResponse) {
        try {
            // The Embedding Provider in Settings is the single source of truth — this
            // keeps chat retrieval on the SAME provider used at index time (mixing
            // local 384-dim and OpenAI 1536-dim vectors silently breaks search).
            // Local embeddings now run via the offscreen document with a fully bundled
            // model + ONNX runtime, so 'local' no longer needs a service-worker DOM.
            await svc.ensureRagEmbeddingProvider();
            ragState.service = svc.ragService;
            const ragService = ragState.service;

            if (ragService.provider === 'openai' && !ragService.apiKey) {
                sendResponse({ success: false, error: 'OpenAI API key required for the OpenAI embedding provider. Set it in Settings, or switch Embedding Provider to Local.' });
                return;
            }

            await ragService.init((progress) => {
                if (progress) {
                    chrome.runtime
                        .sendMessage({ type: 'RAG_MODEL_PROGRESS', payload: progress })
                        .catch(() => {});
                }
            });

            sendResponse({ success: true, providerInfo: ragService.getProviderInfo() });
        } catch (error) {
            console.error('RAG initialization failed:', error);
            sendResponse({ success: false, error: error.message || 'Failed to initialize RAG service' });
        }
    }

    async function handleIndexRepo(message, sendResponse) {
        const ragService = ragState.service;
        if (!ragService) {
            sendResponse({ success: false, error: 'RAG Service not initialized' });
            return;
        }
        const { repoId, files } = message.payload || {};
        await ragService.indexRepositoryIncremental(repoId, files, (progress) => {
            chrome.runtime.sendMessage({ type: 'RAG_PROGRESS', payload: progress }).catch(() => {});
        });
        sendResponse({ success: true });
    }

    async function handleRetrieveContext(message, sendResponse) {
        const ragService = ragState.service;
        if (!ragService) {
            sendResponse({ success: false, error: 'RAG Service not initialized' });
            return;
        }
        const { repoId, query } = message.payload || {};
        const results = await ragService.retrieveContext(repoId, query);
        sendResponse({ success: true, results });
    }

    async function handleCheckIndexed(message, sendResponse) {
        const ragService = ragState.service;
        if (!ragService) {
            sendResponse({ success: false, error: 'RAG Service not initialized' });
            return;
        }
        const isIndexed = await ragService.vectorStore.isIndexed(message.payload?.repoId);
        sendResponse({ success: true, isIndexed });
    }

    async function handleAutoIndexRepo(message, sendResponse) {
        try {
            const { url, provider, apiKey, token } = message.payload || {};

            if (!ragState.service) {
                ragState.service = new RAGService({ provider, apiKey });
                await ragState.service.init();
            }
            const ragService = ragState.service;

            let service;
            let repoId;
            if (url.includes('github.com')) {
                service = new GitHubService(token);
                repoId = service.getRepoId(url);
            } else if (url.includes('gitlab.com')) {
                service = new GitLabService(token);
                repoId = service.getRepoId(url);
            } else {
                sendResponse({ success: false, error: 'Unsupported platform' });
                return;
            }

            const files = await service.fetchRepositoryFiles(url, (progress) => {
                chrome.runtime.sendMessage({ type: 'AUTO_INDEX_PROGRESS', payload: progress }).catch(() => {});
            });

            await ragService.indexRepositoryIncremental(repoId, files, (progress) => {
                chrome.runtime.sendMessage({ type: 'RAG_PROGRESS', payload: progress }).catch(() => {});
            });

            sendResponse({ success: true, repoId, filesIndexed: files.length });
        } catch (error) {
            console.error('Auto-index error:', error);
            sendResponse({ success: false, error: error.message || 'Auto-index failed' });
        }
    }

    return {
        INIT_RAG: handleInitRag,
        INDEX_REPO: handleIndexRepo,
        RETRIEVE_CONTEXT: handleRetrieveContext,
        CHECK_INDEXED: handleCheckIndexed,
        AUTO_INDEX_REPO: handleAutoIndexRepo,
    };
}

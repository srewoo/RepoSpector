/**
 * Repository-indexing message handlers.
 *
 * Extracted verbatim from the `BackgroundService` class in
 * `src/background/index.js`. Each handler was a method on that class; here they
 * are plain async functions produced by the `createIndexingHandlers(svc)`
 * factory, where `svc` is the live BackgroundService instance. Every former
 * `this.X` reference becomes `svc.X`.
 *
 * Private helpers these handlers depend on (e.g. `saveRepoMetadata`,
 * `ensureRagEmbeddingProvider`, `getErrorMessage`, `getStoredSettings`) remain
 * defined on the BackgroundService class and are reached through `svc`.
 *
 * The moved methods use only `chrome.*` globals and `svc.*` members, so this
 * module needs no additional imports.
 */

export function createIndexingHandlers(svc) {
    async function handleIndexRepository(message, sender, sendResponse) {
        try {
            const { url } = message.data || message.payload || {};
            const tabId = sender?.tab?.id;

            if (!url) {
                sendResponse({ success: false, error: 'URL is required' });
                return;
            }

            console.log('🔄 Starting repository indexing for:', url);

            // Determine platform (GitHub or GitLab)
            let service;
            let repoId;

            if (url.includes('github.com')) {
                console.log('🔵 Detected GitHub repository');
                service = svc.githubService;
                repoId = service.getRepoId(url);
                console.log('📌 Extracted repoId:', repoId);
            } else if (url.includes('gitlab.com')) {
                console.log('🟠 Detected GitLab repository');
                service = svc.gitlabService;
                repoId = service.getRepoId(url);
                console.log('📌 Extracted repoId:', repoId);
            } else {
                sendResponse({ success: false, error: 'Unsupported platform. Only GitHub and GitLab are supported.' });
                return;
            }

            if (!repoId) {
                console.error('❌ Failed to extract repoId from URL:', url);
                sendResponse({ success: false, error: 'Failed to parse repository ID from URL. Check console for details.' });
                return;
            }

            console.log('✅ Repository identified:', { platform: url.includes('github.com') ? 'GitHub' : 'GitLab', repoId });

            // Honor the embedding provider selected in Settings, then initialize.
            await svc.ensureRagEmbeddingProvider();
            await svc.ragService.init();

            // Send initial progress
            if (tabId) {
                chrome.tabs.sendMessage(tabId, {
                    type: 'INDEX_PROGRESS',
                    data: { status: 'starting', message: 'Initializing indexing...' }
                }).catch(() => { });
            }

            // Fetch repository files
            const files = await service.fetchRepositoryFiles(url, (progress) => {
                console.log('📥 Fetch progress:', progress);
                if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'INDEX_PROGRESS',
                        data: progress
                    }).catch(() => { });
                }
            });

            console.log(`📚 Fetched ${files.length} files from repository`);

            // Index the repository
            const result = await svc.ragService.indexRepositoryIncremental(
                repoId,
                files,
                (progress) => {
                    console.log('🔍 Index progress:', progress);
                    if (tabId) {
                        chrome.tabs.sendMessage(tabId, {
                            type: 'INDEX_PROGRESS',
                            data: progress
                        }).catch(() => { });
                    }
                }
            );

            console.log('✅ Repository indexed successfully:', result);

            // Build/refresh Knowledge Graph (symbols, calls, coverage, communities, flows).
            // updateGraph re-parses only changed files (full build on first run).
            let graphStats = null;
            try {
                graphStats = await svc.codeGraphPipeline.updateGraph(repoId, files, (progress) => {
                    console.log('🧠 Graph:', progress.message);
                    if (tabId) {
                        chrome.tabs.sendMessage(tabId, {
                            type: 'INDEX_PROGRESS',
                            data: { status: 'graph', message: progress.message }
                        }).catch(() => { });
                    }
                });
                console.log('✅ Knowledge graph built:', graphStats);
            } catch (graphError) {
                console.warn('⚠️ Knowledge graph build failed (non-fatal):', graphError.message);
            }

            // Determine platform
            const platform = url.includes('gitlab') ? 'gitlab' : 'github';

            // Save metadata for the repos view
            await svc.saveRepoMetadata(repoId, url, platform, {
                chunksIndexed: result.chunksIndexed,
                filesProcessed: files.length,
                graphStats
            });

            // Broadcast completion to popup
            chrome.runtime.sendMessage({
                type: 'INDEX_PROGRESS',
                data: { status: 'complete', repoId }
            }).catch(() => { });

            sendResponse({
                success: true,
                repoId,
                filesIndexed: files.length,
                chunksIndexed: result.chunksIndexed
            });
        } catch (error) {
            console.error('❌ Repository indexing failed:', error);
            svc.errorHandler.logError('Index repository', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Check if a repository is indexed
     */
    async function handleCheckIndexStatus(message, sendResponse) {
        try {
            const { url } = message.data || message.payload || {};

            if (!url) {
                sendResponse({ success: false, error: 'URL is required' });
                return;
            }

            // Determine repoId
            let repoId;
            if (url.includes('github.com')) {
                repoId = svc.githubService.getRepoId(url);
            } else if (url.includes('gitlab.com')) {
                repoId = svc.gitlabService.getRepoId(url);
            } else {
                sendResponse({ success: false, error: 'Unsupported platform' });
                return;
            }

            // Check if indexed
            await svc.ragService.init();
            const isIndexed = await svc.ragService.vectorStore.isIndexed(repoId);

            sendResponse({
                success: true,
                isIndexed,
                repoId
            });
        } catch (error) {
            svc.errorHandler.logError('Check index status', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Clear index for a repository
     */
    async function handleClearIndex(message, sendResponse) {
        try {
            const { url, repoId: providedRepoId } = message.data || message.payload || {};

            let repoId = providedRepoId;

            if (!repoId && url) {
                // Determine repoId from URL
                if (url.includes('github.com')) {
                    repoId = svc.githubService.getRepoId(url);
                } else if (url.includes('gitlab.com')) {
                    repoId = svc.gitlabService.getRepoId(url);
                }
            }

            if (!repoId) {
                sendResponse({ success: false, error: 'Repository ID or URL is required' });
                return;
            }

            await svc.ragService.init();
            await svc.ragService.vectorStore.clearRepo(repoId);

            console.log('🗑️ Cleared index for repository:', repoId);

            sendResponse({
                success: true,
                repoId
            });
        } catch (error) {
            svc.errorHandler.logError('Clear index', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Get indexing statistics
     */
    async function handleGetIndexStats(message, sendResponse) {
        try {
            await svc.ragService.init();
            const stats = await svc.ragService.vectorStore.getStats();

            sendResponse({
                success: true,
                stats
            });
        } catch (error) {
            svc.errorHandler.logError('Get index stats', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Get all indexed repositories with metadata
     */
    async function handleGetIndexedRepos(message, sendResponse) {
        try {
            await svc.ragService.init();

            // Get all repos from VectorStore
            const reposFromDb = await svc.ragService.vectorStore.getAllRepoIds();

            // Get metadata from chrome.storage.local
            const result = await chrome.storage.local.get(['indexedReposMetadata']);
            const metadata = result.indexedReposMetadata || {};

            // Merge data: repo stats from DB + metadata from storage
            const repos = await Promise.all(reposFromDb.map(async (repo) => {
                const repoStats = await svc.ragService.vectorStore.getRepoStats(repo.repoId);
                const repoMetadata = metadata[repo.repoId] || {};

                // Determine platform from repoId pattern or stored metadata
                const platform = repoMetadata.platform ||
                    (repo.repoId.includes('/') ? 'github' : 'unknown');

                return {
                    repoId: repo.repoId,
                    platform: platform,
                    url: repoMetadata.url || `https://github.com/${repo.repoId}`,
                    indexedAt: repoMetadata.indexedAt || null,
                    chunksCount: repoStats.chunksCount,
                    filesCount: repoStats.filesCount
                };
            }));

            sendResponse({
                success: true,
                data: repos
            });
        } catch (error) {
            svc.errorHandler.logError('Get indexed repos', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    /**
     * Delete a repository index and its metadata
     */
    async function handleDeleteRepoIndex(message, sendResponse) {
        try {
            const { repoId } = message.data || message.payload || {};

            if (!repoId) {
                sendResponse({ success: false, error: 'Repository ID is required' });
                return;
            }

            // Clear from VectorStore
            await svc.ragService.init();
            await svc.ragService.vectorStore.clearRepo(repoId);

            // Clear Knowledge Graph for this repo
            try {
                await svc.codeGraphPipeline.deleteGraph(repoId);
                console.log('🧠 Knowledge graph deleted for:', repoId);
            } catch (graphErr) {
                console.warn('Knowledge graph deletion failed (non-fatal):', graphErr.message);
            }

            // Remove metadata from storage
            const result = await chrome.storage.local.get(['indexedReposMetadata']);
            const metadata = result.indexedReposMetadata || {};
            delete metadata[repoId];
            await chrome.storage.local.set({ indexedReposMetadata: metadata });

            console.log('🗑️ Deleted repository index:', repoId);

            sendResponse({
                success: true,
                repoId
            });
        } catch (error) {
            svc.errorHandler.logError('Delete repo index', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    return {
        INDEX_REPOSITORY: (m, send, sender) => handleIndexRepository(m, sender, send),
        CHECK_INDEX_STATUS: (m, send) => handleCheckIndexStatus(m, send),
        CLEAR_INDEX: (m, send) => handleClearIndex(m, send),
        GET_INDEX_STATS: (m, send) => handleGetIndexStats(m, send),
        GET_INDEXED_REPOS: (m, send) => handleGetIndexedRepos(m, send),
        DELETE_REPO_INDEX: (m, send) => handleDeleteRepoIndex(m, send),
    };
}

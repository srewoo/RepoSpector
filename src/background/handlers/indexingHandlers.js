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

import { detectPlatform } from '../../utils/gitHosts.js';
import { ConventionMiner } from '../../services/ConventionMiner.js';

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

            if (detectPlatform(url) === 'github') {
                console.log('🔵 Detected GitHub repository');
                service = svc.githubService;
                repoId = service.getRepoId(url);
                console.log('📌 Extracted repoId:', repoId);
            } else if (detectPlatform(url) === 'gitlab') {
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

            console.log('✅ Repository identified:', { platform: detectPlatform(url) === 'github' ? 'GitHub' : 'GitLab', repoId });

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
            if (!files || files.length === 0) {
                sendResponse({
                    success: false,
                    repoId,
                    error: 'No files fetched from the repository. Check your token/permissions and that the repo path is correct (nested GitLab groups included).'
                });
                return;
            }

            // Index the repository. The manual button forces a full, fresh index so it
            // can never silently no-op on a stale manifest.
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
                },
                { force: message.data?.force !== false }
            );

            console.log('✅ Repository index result:', result);
            if (result && result.success === false) {
                chrome.runtime.sendMessage({ type: 'INDEX_PROGRESS', data: { status: 'error', repoId } }).catch(() => { });
                sendResponse({ success: false, repoId, error: result.error || 'Indexing failed.' });
                return;
            }

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

            // Verify vectors actually landed in the store. The indexed-repos list is
            // built by cursoring the vector store, so if nothing persisted the repo
            // would never show up — report that truthfully instead of a false success.
            const persisted = await svc.ragService.vectorStore.isIndexed(repoId).catch(() => false);
            if (!persisted) {
                chrome.runtime.sendMessage({ type: 'INDEX_PROGRESS', data: { status: 'error', repoId } }).catch(() => { });
                sendResponse({
                    success: false,
                    repoId,
                    error: 'Indexing produced no vectors — the embedding provider may have failed or the repo had no supported files. It will not appear as indexed.'
                });
                return;
            }

            // Determine platform
            const platform = url.includes('gitlab') ? 'gitlab' : 'github';

            // Save metadata for the repos view
            await svc.saveRepoMetadata(repoId, url, platform, {
                chunksIndexed: result.chunksIndexed,
                filesProcessed: files.length,
                graphStats
            });

            // Warm team conventions now. Indexing already took a while and the
            // user is not waiting on this, so the mine is free here — and being
            // warm is what lets the FIRST review use the repo's own conventions.
            //
            // Note: `url` here is the repository URL the user indexed from, not
            // necessarily a PR/MR URL. `fetchReviewComments` parses a PR/MR URL
            // to find the repo and walk its recent history; given a bare repo
            // URL it returns `[]` (see its `parsePullRequestUrl` call), so this
            // trigger is a harmless no-op in that case. It still works whenever
            // indexing was kicked off from a PR/MR page. Fixing the repo-URL
            // case would mean inventing a repo-URL crawl, which is out of scope
            // here — `mine()` only persists on its success path, so a prewarm
            // that fetches zero notes cannot poison the 14-day cache.
            try {
                const miner = new ConventionMiner({ llmService: svc.llmService });
                miner.prewarm(
                    repoId,
                    () => svc.pullRequestService?.fetchReviewComments?.(url) ?? Promise.resolve([]),
                    { settings: await svc.getStoredSettings().catch(() => ({})) },
                );
            } catch (e) {
                console.warn('Convention prewarm at index time:', e?.message);
            }

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
            if (detectPlatform(url) === 'github') {
                repoId = svc.githubService.getRepoId(url);
            } else if (detectPlatform(url) === 'gitlab') {
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
                if (detectPlatform(url) === 'github') {
                    repoId = svc.githubService.getRepoId(url);
                } else if (detectPlatform(url) === 'gitlab') {
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
            console.log(`📚 GET_INDEXED_REPOS: vector store has ${reposFromDb.length} repo(s):`, reposFromDb.map(r => r.repoId));

            // Get metadata from chrome.storage.local
            const result = await chrome.storage.local.get(['indexedReposMetadata']);
            const metadata = result.indexedReposMetadata || {};

            // Merge data: repo stats from DB + metadata from storage. Per-repo try/catch
            // so one bad getRepoStats can't reject the whole list (which would blank the
            // panel even though repos ARE indexed).
            const settled = await Promise.all(reposFromDb.map(async (repo) => {
                // GitLab indexing can key a repo by its NUMERIC project id, so repoId
                // is not always a string. Calling a string method on it (`.includes`)
                // threw inside this map, rejecting the whole Promise.all and making the
                // handler return success:false — the Repos panel then rendered "no
                // repositories indexed" while the store held seven. Coerce once, and
                // wrap each repo so a single bad entry can never blank the list again.
                try {
                    const repoId = String(repo.repoId ?? '');
                    if (!repoId) return null;

                    let repoStats = { chunksCount: repo.chunksCount ?? 0, filesCount: 0 };
                    try {
                        repoStats = await svc.ragService.vectorStore.getRepoStats(repo.repoId);
                    } catch (statErr) {
                        console.warn(`getRepoStats failed for ${repoId} (using fallback):`, statErr?.message);
                    }

                    const repoMetadata = metadata[repoId] || metadata[repo.repoId] || {};
                    const platform = repoMetadata.platform ||
                        (repoId.includes('/')
                            ? (repoMetadata.url?.includes('gitlab') ? 'gitlab' : 'github')
                            : 'unknown');

                    return {
                        repoId,
                        platform,
                        url: repoMetadata.url || null,
                        indexedAt: repoMetadata.indexedAt || null,
                        chunksCount: repoStats.chunksCount,
                        filesCount: repoStats.filesCount
                    };
                } catch (repoErr) {
                    console.warn(`Skipping repo entry ${String(repo?.repoId)}:`, repoErr?.message);
                    return null;
                }
            }));

            const repos = settled.filter(Boolean);
            if (repos.length !== reposFromDb.length) {
                console.warn(`GET_INDEXED_REPOS: ${reposFromDb.length - repos.length} repo entry/entries skipped`);
            }

            sendResponse({ success: true, data: repos });
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

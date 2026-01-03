import React, { useState, useEffect } from 'react';
import {
    Database,
    RefreshCw,
    Trash2,
    ExternalLink,
    GitBranch,
    Clock,
    FileCode,
    Package,
    AlertCircle,
    CheckCircle,
    Plus
} from 'lucide-react';
import { Button } from './ui/Button';
import { Card, CardContent } from './ui/Card';
import { IndexingProgress } from './IndexingProgress';
import { motion, AnimatePresence } from 'framer-motion';

function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Unknown';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(timestamp).toLocaleDateString();
}

function RepoCard({ repo, onReindex, onClear, onDelete, isActive }) {
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
        >
            <Card className={`transition-all ${isActive ? 'border-primary/50 bg-primary/5' : ''}`}>
                <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <GitBranch className="w-4 h-4 text-primary shrink-0" />
                            <div className="min-w-0">
                                <h4 className="font-medium text-sm text-text truncate">
                                    {repo.repoId}
                                </h4>
                                <p className="text-xs text-textMuted truncate">
                                    {repo.platform === 'github' ? 'GitHub' : 'GitLab'}
                                </p>
                            </div>
                        </div>
                        {isActive && (
                            <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded-full shrink-0">
                                Current
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-textMuted">
                        <div className="flex items-center gap-1">
                            <Package className="w-3 h-3" />
                            <span>{repo.chunksCount || 0} chunks</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <FileCode className="w-3 h-3" />
                            <span>{repo.filesCount || 0} files</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{formatTimeAgo(repo.indexedAt)}</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onReindex(repo)}
                            className="flex-1 text-xs h-8"
                        >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            Re-index
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onClear(repo)}
                            className="text-xs h-8 px-3"
                        >
                            Clear
                        </Button>
                        {showConfirmDelete ? (
                            <div className="flex items-center gap-1">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => onDelete(repo)}
                                    className="text-xs h-8 px-2 text-error hover:bg-error/10"
                                >
                                    Confirm
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setShowConfirmDelete(false)}
                                    className="text-xs h-8 px-2"
                                >
                                    Cancel
                                </Button>
                            </div>
                        ) : (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setShowConfirmDelete(true)}
                                className="text-xs h-8 px-2 text-textMuted hover:text-error"
                            >
                                <Trash2 className="w-3 h-3" />
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>
        </motion.div>
    );
}

export function ReposView() {
    const [indexedRepos, setIndexedRepos] = useState([]);
    const [currentRepo, setCurrentRepo] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isIndexing, setIsIndexing] = useState(false);
    const [indexProgress, setIndexProgress] = useState(null);
    const [error, setError] = useState(null);
    const [hasApiKey, setHasApiKey] = useState(false);

    // Load data on mount
    useEffect(() => {
        loadData();
        getCurrentTab();

        // Listen for indexing progress
        const listener = (message) => {
            if (message.type === 'INDEX_PROGRESS') {
                setIndexProgress(message.data);
                if (message.data.status === 'complete') {
                    setIsIndexing(false);
                    loadData();
                } else if (message.data.status === 'error') {
                    setIsIndexing(false);
                    setError(message.data.message);
                }
            }
        };

        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
    }, []);

    const loadData = async () => {
        try {
            // Get indexed repos
            const reposResponse = await chrome.runtime.sendMessage({
                type: 'GET_INDEXED_REPOS'
            });
            if (reposResponse.success) {
                setIndexedRepos(reposResponse.data || []);
            }

            // Check if API key is set
            const settingsResponse = await chrome.runtime.sendMessage({
                type: 'GET_SETTINGS'
            });
            if (settingsResponse.success) {
                setHasApiKey(!!settingsResponse.data?.apiKey);
            }
        } catch (err) {
            console.error('Failed to load data:', err);
            setError('Failed to load repository data');
        } finally {
            setIsLoading(false);
        }
    };

    const getCurrentTab = async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url && (tab.url.includes('github.com') || tab.url.includes('gitlab.com'))) {
                // Extract repo info from URL
                const url = new URL(tab.url);
                const pathParts = url.pathname.split('/').filter(Boolean);
                if (pathParts.length >= 2) {
                    const repoId = `${pathParts[0]}/${pathParts[1]}`;
                    const platform = url.hostname.includes('gitlab') ? 'gitlab' : 'github';
                    setCurrentRepo({
                        url: tab.url,
                        repoId,
                        platform
                    });
                }
            }
        } catch (err) {
            console.error('Failed to get current tab:', err);
        }
    };

    const handleIndex = async (repo = null) => {
        if (!hasApiKey) {
            setError('Please set your API key in Settings before indexing.');
            return;
        }

        const targetUrl = repo?.url || currentRepo?.url;
        if (!targetUrl) {
            setError('No repository detected. Navigate to a GitHub or GitLab repository.');
            return;
        }

        setIsIndexing(true);
        setIndexProgress({ status: 'starting', message: 'Initializing...' });
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'INDEX_REPOSITORY',
                data: { url: targetUrl }
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to start indexing');
            }
        } catch (err) {
            setError(err.message || 'Failed to index repository');
            setIsIndexing(false);
        }
    };

    const handleClear = async (repo) => {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'CLEAR_INDEX',
                data: { repoId: repo.repoId }
            });

            if (response.success) {
                loadData();
            } else {
                setError(response.error || 'Failed to clear index');
            }
        } catch (err) {
            setError('Failed to clear index');
        }
    };

    const handleDelete = async (repo) => {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'DELETE_REPO_INDEX',
                data: { repoId: repo.repoId }
            });

            if (response.success) {
                loadData();
            } else {
                setError(response.error || 'Failed to delete repository');
            }
        } catch (err) {
            setError('Failed to delete repository');
        }
    };

    const isCurrentRepoIndexed = currentRepo && indexedRepos.some(r => r.repoId === currentRepo.repoId);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-text flex items-center gap-2">
                    <Database className="w-5 h-5 text-primary" />
                    Repositories
                </h2>
                <span className="text-xs text-textMuted">
                    {indexedRepos.length} indexed
                </span>
            </div>

            {/* Error Display */}
            {error && (
                <div className="flex items-start gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-error mt-0.5 shrink-0" />
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {/* API Key Warning */}
            {!hasApiKey && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                    <div className="text-sm text-warning">
                        <p className="font-medium">API Key Required</p>
                        <p className="text-xs text-warning/80 mt-1">
                            Set your API key in Settings to enable repository indexing.
                        </p>
                    </div>
                </div>
            )}

            {/* Current Repository Section */}
            {currentRepo && (
                <Card className="border-primary/30 bg-primary/5">
                    <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                                <GitBranch className="w-4 h-4 text-primary" />
                                Current Repository
                            </h3>
                            {isCurrentRepoIndexed && (
                                <CheckCircle className="w-4 h-4 text-success" />
                            )}
                        </div>

                        <div className="flex items-center gap-2">
                            <span className="text-sm text-text font-medium">{currentRepo.repoId}</span>
                            <span className="text-xs text-textMuted px-1.5 py-0.5 bg-surfaceHighlight rounded">
                                {currentRepo.platform}
                            </span>
                        </div>

                        {/* Indexing Progress */}
                        {isIndexing && indexProgress && (
                            <IndexingProgress progress={indexProgress} />
                        )}

                        {!isIndexing && (
                            isCurrentRepoIndexed ? (
                                <div className="flex items-center gap-2 p-2 bg-success/10 border border-success/20 rounded-lg">
                                    <CheckCircle className="w-4 h-4 text-success" />
                                    <span className="text-sm text-success">
                                        Already indexed — use Re-index below to update
                                    </span>
                                </div>
                            ) : (
                                <Button
                                    onClick={() => handleIndex()}
                                    disabled={!hasApiKey}
                                    className="w-full"
                                >
                                    <Plus className="w-4 h-4 mr-2" />
                                    Index Repository
                                </Button>
                            )
                        )}
                    </CardContent>
                </Card>
            )}

            {/* No Current Repo Message */}
            {!currentRepo && (
                <Card className="border-dashed">
                    <CardContent className="p-6 text-center space-y-2">
                        <ExternalLink className="w-8 h-8 text-textMuted mx-auto" />
                        <p className="text-sm text-textMuted">
                            Navigate to a GitHub or GitLab repository to index it
                        </p>
                    </CardContent>
                </Card>
            )}

            {/* Indexed Repositories List */}
            {indexedRepos.length > 0 && (
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-text">Indexed Repositories</h3>
                    <AnimatePresence mode="popLayout">
                        {indexedRepos.map((repo) => (
                            <RepoCard
                                key={repo.repoId}
                                repo={repo}
                                onReindex={handleIndex}
                                onClear={handleClear}
                                onDelete={handleDelete}
                                isActive={currentRepo?.repoId === repo.repoId}
                            />
                        ))}
                    </AnimatePresence>
                </div>
            )}

            {/* Empty State */}
            {indexedRepos.length === 0 && currentRepo && !isIndexing && (
                <div className="text-center py-6 space-y-2">
                    <Database className="w-10 h-10 text-textMuted/50 mx-auto" />
                    <p className="text-sm text-textMuted">No repositories indexed yet</p>
                    <p className="text-xs text-textMuted/70">
                        Index the current repository to enable deep context in chat
                    </p>
                </div>
            )}
        </div>
    );
}

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Layout } from './components/Layout';
import { Settings } from './components/Settings';
import { ChatInterface } from './components/ChatInterface';
import { ReposView } from './components/ReposView';
import { TabNavigation } from './components/TabNavigation';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './components/ui/Toast';
import { Button } from './components/ui/Button';
import { Card, CardContent } from './components/ui/Card';
import { PRReviewInterface } from './components/PRReviewInterface';
import { Sparkles, Code2, FileCode, GitPullRequest, RefreshCw, AlertCircle, Github, ExternalLink, BookOpen } from 'lucide-react';

/**
 * The published handbook: features, setup paths and symptom-keyed
 * troubleshooting. Linked from the welcome panel because the panel's job is
 * getting someone to a first result, and the two failures that most often
 * stop that (Ollama refusing the extension's origin, and picking the wrong
 * key for indexing) both have a named fix there.
 */
const HANDBOOK_URL = 'https://claude.ai/code/artifact/0f39a03d-875a-4345-b3c5-eb348dfeb00e';
import { buildAnalyzePROptions } from './prReviewRequestOptions';
import { probeChromeAI } from '../utils/chromeAI.js';
import { rankKeylessRoutes } from './utils/keylessRoutes.js';

// Shape the MULTI_PASS_PR_REVIEW response into the analysisResult the UI consumes.
// Used by both a live run and by picking up a cached background/auto review.
function mapReviewData(data) {
    return {
        reviewedAt: data.reviewedAt || null,
        analysis: data.analysis,
        recommendation: data.staticAnalysis?.recommendation,
        reviewEffort: data.reviewEffort,
        isMultiPass: data.isMultiPass || false,
        perFileFindings: data.perFileFindings,
        verifiedFindings: data.verifiedFindings,
        reviewVerdict: data.reviewVerdict,
        reviewEvent: data.reviewEvent,
        blockingCount: data.blockingCount,
        reviewQuality: data.reviewQuality,
        failedFiles: data.failedFiles,
        processingTime: data.processingTime
    };
}

function AppContent() {
    const [activeTab, setActiveTab] = useState('home');
    const [testType, setTestType] = useState(null);
    const [indexedRepoCount, setIndexedRepoCount] = useState(0);

    // PR Review state
    const [prUrl, setPrUrl] = useState(null);
    const prUrlRef = useRef(null); // stable PR URL for the progress listener closure
    const [prData, setPrData] = useState(null);
    const [prAnalysisResult, setPrAnalysisResult] = useState(null);
    const [prStaticAnalysisResult, setPrStaticAnalysisResult] = useState(null);
    const [prAiSummary, setPrAiSummary] = useState(null);
    // Why the summary is missing, when it is. Without it the empty state cannot
    // tell "the call was refused" apart from "nothing to summarize".
    const [prAiSummaryError, setPrAiSummaryError] = useState(null);
    const [prSession, setPrSession] = useState(null);
    const [prLoading, setPrLoading] = useState(false);
    const [prError, setPrError] = useState(null);
    // 'auth' when the review failed because a credential was rejected. Rendered
    // differently from an ordinary failure: "Try Again" is useless advice for a
    // bad key, and the fix is one click away in Settings.
    const [prErrorKind, setPrErrorKind] = useState(null);
    const [prProgress, setPrProgress] = useState(null);
    const [isOnPRPage, setIsOnPRPage] = useState(false);
    const [isOnGitPage, setIsOnGitPage] = useState(null); // null = loading, true/false = detected

    // Welcome-panel keyless routes (#task8). `hasExistingKey` mirrors the same
    // `!!settings.apiKey` check Settings.jsx does after GET_SETTINGS — App.jsx
    // otherwise has no notion of whether a key is configured.
    const [hasExistingKey, setHasExistingKey] = useState(false);
    const [keylessRoutes, setKeylessRoutes] = useState(null);

    // Load indexed repo count on mount
    useEffect(() => {
        const loadRepoCount = async () => {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_INDEXED_REPOS'
                });
                if (response.success && response.data) {
                    setIndexedRepoCount(response.data.length);
                }
            } catch (error) {
                console.error('Failed to load indexed repos:', error);
            }
        };

        loadRepoCount();

        // Listen for indexing updates
        const listener = (message) => {
            if (message.type === 'INDEX_PROGRESS' && message.data?.status === 'complete') {
                loadRepoCount();
            }
        };

        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
    }, []);

    // Whether an API key is already configured, for the welcome panel below.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
                if (!cancelled && response?.success && response.data) {
                    setHasExistingKey(!!response.data.apiKey);
                }
            } catch (error) {
                console.error('Failed to load settings:', error);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Rank the keyless welcome-panel routes (#task8). Probed on mount: Chrome's
    // on-device availability client-side (globalThis.LanguageModel exists in
    // extension pages) and Ollama's reachability via the background service
    // worker, which owns provider I/O. PROBE_OLLAMA is deliberately a
    // dedicated message rather than VALIDATE_API_KEY — the latter resolves a
    // model first and throws when none is selected, which is exactly the
    // fresh-install case this panel serves.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [chromeAIResult, ollamaResponse] = await Promise.all([
                probeChromeAI(),
                chrome.runtime.sendMessage({ type: 'PROBE_OLLAMA' }).catch((error) => ({
                    success: false,
                    error: error?.message,
                })),
            ]);
            if (cancelled) return;
            setKeylessRoutes(rankKeylessRoutes({
                chromeAI: chromeAIResult.state,
                chromeAIReason: chromeAIResult.reason,
                ollama: ollamaResponse?.success ? ollamaResponse.verdict : undefined,
                hasKey: hasExistingKey,
                // Flip to true when @repospector/mcp is published — see
                // docs/superpowers/specs/2026-09-08-repospector-mcp-server-design.md
                mcpPublished: false,
            }));
        })();
        return () => { cancelled = true; };
    }, [hasExistingKey]);

    // Listen for multi-pass PR review progress. Streaming findings from the
    // orchestrator arrive as `step === 'chunk_findings'` events with a
    // findings array — accumulate them into a running list so the review
    // view can render incrementally.
    useEffect(() => {
        const progressListener = (message) => {
            if (message.type !== 'PR_REVIEW_PROGRESS') return;
            const data = message.data ?? {};

            // A credential failure ends the review. Show it now rather than
            // leaving a spinner running until the response arrives.
            if (data.phase === 'error' && data.errorKind === 'auth') {
                setPrError(data.message || 'Your API key was rejected.');
                setPrErrorKind('auth');
                setPrLoading(false);
                return;
            }
            // A background/auto review just finished — pull its cached result in so an
            // already-open popup updates without a manual run.
            if (data.phase === 'complete' && prUrlRef.current) {
                chrome.runtime.sendMessage({ type: 'GET_PR_REVIEW_RESULT', data: { prUrl: prUrlRef.current } })
                    .then((cached) => {
                        if (cached?.success && cached.status === 'done' && cached.data) {
                            setPrData(cached.data.prData);
                            setPrAnalysisResult(mapReviewData(cached.data));
                            setPrStaticAnalysisResult(cached.data.staticAnalysis);
                            setPrAiSummary(cached.data.aiSummary || null);
                            setPrAiSummaryError(cached.data.aiSummaryError || null);
                            setPrLoading(false);
                        }
                    })
                    .catch(() => { /* ignore */ });
            }
            setPrProgress((prev) => {
                // Streaming chunk: append to the running findings list.
                if (data.step === 'chunk_findings' && Array.isArray(data.findings)) {
                    const accumulated = [
                        ...(prev?.streamedFindings ?? []),
                        ...data.findings,
                    ];
                    return { ...prev, ...data, streamedFindings: accumulated };
                }
                // Otherwise replace state but preserve any accumulated findings.
                return { ...data, streamedFindings: prev?.streamedFindings ?? [] };
            });
        };
        chrome.runtime.onMessage.addListener(progressListener);
        return () => chrome.runtime.onMessage.removeListener(progressListener);
    }, []);

    // Detect if on a git platform page and/or PR page
    useEffect(() => {
        const checkPage = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.url) {
                    // Check if on any supported git platform
                    const gitPlatformPattern = /github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com|sourceforge\.net|codeberg\.org|gitea\.(io|com)|git\.sr\.ht|pagure\.io/i;
                    setIsOnGitPage(gitPlatformPattern.test(tab.url));

                    // Flexible PR/MR detection patterns
                    const isPRPage =
                        // GitHub-style: any domain with /owner/repo/pull/number
                        /\/[^/]+\/[^/]+\/pull\/\d+/.test(tab.url) ||
                        // GitLab-style: any URL containing /merge_requests/number
                        /\/merge_requests\/\d+/.test(tab.url) ||
                        // Bitbucket-style: any URL containing /pull-requests/number
                        /\/pull-requests\/\d+/.test(tab.url);

                    if (isPRPage) {
                        setIsOnPRPage(true);
                        setPrUrl(tab.url);
                        prUrlRef.current = tab.url;
                        // Pick up a cached background/auto review for this PR (from an
                        // auto-review triggered on the page) so the popup shows results
                        // on open instead of forcing a re-run.
                        try {
                            const cached = await chrome.runtime.sendMessage({
                                type: 'GET_PR_REVIEW_RESULT', data: { prUrl: tab.url }
                            });
                            if (cached?.success && cached.status === 'done' && cached.data) {
                                setPrData(cached.data.prData);
                                setPrAnalysisResult(mapReviewData(cached.data));
                                setPrStaticAnalysisResult(cached.data.staticAnalysis);
                                setPrAiSummary(cached.data.aiSummary || null);
                                setPrAiSummaryError(cached.data.aiSummaryError || null);
                            } else if (cached?.status === 'running') {
                                setPrLoading(true); // background review in flight
                            }
                        } catch { /* no cache → manual run still available */ }
                    } else {
                        setIsOnPRPage(false);
                        setPrUrl(null);
                    }
                } else {
                    setIsOnGitPage(false);
                }
            } catch (error) {
                console.error('Failed to check page:', error);
                setIsOnGitPage(false);
            }
        };

        checkPage();
    }, [activeTab]);

    // Analyze PR
    const analyzePR = useCallback(async (focusArea = null, { bypassCache = false } = {}) => {
        if (!prUrl) return;

        setPrLoading(true);
        setPrError(null);
        setPrErrorKind(null);
        setPrAiSummary(null);
        setPrAiSummaryError(null);

        try {
            setPrProgress(null);
            const response = await chrome.runtime.sendMessage({
                type: 'MULTI_PASS_PR_REVIEW',
                data: {
                    prUrl,
                    options: buildAnalyzePROptions(focusArea, { bypassCache })
                }
            });

            if (response.success) {
                setPrData(response.data.prData);
                setPrAnalysisResult(mapReviewData(response.data));
                setPrStaticAnalysisResult(response.data.staticAnalysis);
                setPrAiSummary(response.data.aiSummary || null);
                setPrAiSummaryError(response.data.aiSummaryError || null);
                // Create a session object for thread management
                setPrSession({
                    sessionId: `pr-${Date.now()}`,
                    prUrl,
                    createdAt: new Date().toISOString()
                });
            } else {
                setPrError(response.error || 'Failed to analyze PR');
                setPrErrorKind(response.errorKind || null);
            }
        } catch (error) {
            setPrError(error.message || 'Failed to analyze PR');
        } finally {
            setPrLoading(false);
        }
    }, [prUrl]);

    // Handle PR focus area change
    const handlePRFocusArea = useCallback((area) => {
        analyzePR(area);
    }, [analyzePR]);

    // Handle PR refresh. This backs both the "Re-run" affordances the user
    // presses deliberately (next to "Reviewed Xh ago" and inside a failed
    // summary card) as well as the "Try Again" button after a hard failure —
    // all explicit user actions that must not be served a stale cached
    // review (e.g. one poisoned by a since-fixed provider credit/auth
    // error). Unlike the automatic/initial analyzePR() call, this bypasses
    // the review cache.
    const handlePRRefresh = useCallback(() => {
        analyzePR(null, { bypassCache: true });
    }, [analyzePR]);

    // Handle asking a question about the PR (switches to chat)
    const handlePRAskQuestion = useCallback(() => {
        setActiveTab('chat');
    }, []);

    const handleGenerateTests = (type) => {
        setTestType(type);
        setActiveTab('chat');
    };

    const handleTabChange = (tab) => {
        if (tab !== 'chat') {
            setTestType(null);
        }
        setActiveTab(tab);
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'settings':
                return <Settings onClose={() => setActiveTab('home')} />;
            case 'chat':
                return (
                    <ChatInterface
                        autoGenerateType={testType}
                        onBack={() => {
                            setActiveTab('home');
                            setTestType(null);
                        }}
                    />
                );
            case 'repos':
                return <ReposView />;
            case 'prreview':
                return (
                    <div className="space-y-4 animate-fade-in">
                        {!isOnPRPage ? (
                            // Not on a PR page
                            <Card className="p-6 text-center">
                                <GitPullRequest className="w-12 h-12 mx-auto text-textMuted mb-3" />
                                <h3 className="text-lg font-medium text-text">No Pull Request Detected</h3>
                                <p className="text-sm text-textMuted mt-2 max-w-[280px] mx-auto">
                                    Navigate to a GitHub, GitLab, or Bitbucket pull request page to analyze it
                                </p>
                            </Card>
                        ) : prError ? (
                            // Error state. A credential failure is called out as
                            // one: it is the single failure a reviewer must never
                            // mistake for "nothing found", and retrying it without
                            // changing the key just fails again.
                            <Card className="p-6 text-center">
                                <AlertCircle className={`w-12 h-12 mx-auto mb-3 ${prErrorKind === 'auth' ? 'text-amber-500' : 'text-red-500'}`} />
                                <h3 className="text-lg font-medium text-text">
                                    {prErrorKind === 'auth' ? 'API key problem' : 'Analysis Failed'}
                                </h3>
                                <p className="text-sm text-textMuted mt-2">{prError}</p>
                                {prErrorKind === 'auth' && (
                                    <p className="text-xs text-amber-500 mt-3">
                                        This PR was <strong>not reviewed</strong>. Nothing here says the code is clean.
                                    </p>
                                )}
                                <div className="flex items-center justify-center gap-2 mt-4">
                                    {prErrorKind === 'auth' && (
                                        <Button onClick={() => handleTabChange('settings')}>
                                            Open Settings
                                        </Button>
                                    )}
                                    <Button
                                        onClick={handlePRRefresh}
                                        variant={prErrorKind === 'auth' ? 'outline' : 'default'}
                                        disabled={prLoading}
                                    >
                                        <RefreshCw className={`w-4 h-4 mr-2 ${prLoading ? 'animate-spin' : ''}`} />
                                        Try Again
                                    </Button>
                                </div>
                            </Card>
                        ) : !prAnalysisResult && !prLoading ? (
                            // Ready to analyze
                            <Card className="p-6 text-center">
                                <GitPullRequest className="w-12 h-12 mx-auto text-primary mb-3" />
                                <h3 className="text-lg font-medium text-text">Ready to Analyze</h3>
                                <p className="text-sm text-textMuted mt-2 max-w-[280px] mx-auto">
                                    Click below to run AI-powered analysis with static code checks
                                </p>
                                <Button
                                    onClick={() => analyzePR()}
                                    className="mt-4"
                                    disabled={prLoading}
                                >
                                    <GitPullRequest className="w-4 h-4 mr-2" />
                                    Analyze Pull Request
                                </Button>
                            </Card>
                        ) : (
                            // Show PR Review Interface
                            <PRReviewInterface
                                prUrl={prUrl}
                                prData={prData}
                                analysisResult={prAnalysisResult}
                                staticAnalysisResult={prStaticAnalysisResult}
                                aiSummary={prAiSummary}
                                aiSummaryError={prAiSummaryError}
                                onOpenSettings={() => handleTabChange('settings')}
                                session={prSession}
                                onRefresh={handlePRRefresh}
                                onAskQuestion={handlePRAskQuestion}
                                onFocusArea={handlePRFocusArea}
                                loading={prLoading}
                                progress={prProgress}
                            />
                        )}
                    </div>
                );
            case 'home':
            default:
                // Show prompt to open a git page when not on one
                if (isOnGitPage === false) {
                    return (
                        <div className="space-y-6 animate-fade-in">
                            <div className="text-center space-y-3 py-8">
                                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-border mb-2 shadow-inner">
                                    <Github className="w-8 h-8 text-primary" />
                                </div>
                                <h2 className="text-xl font-bold text-text">
                                    Open a Git Page
                                </h2>
                                <p className="text-sm text-textMuted max-w-[300px] mx-auto leading-relaxed">
                                    Navigate to a repository on GitHub, GitLab, Bitbucket, or any supported git platform to start using RepoSpector.
                                </p>
                            </div>

                            <div className="bg-surfaceHighlight/30 border border-border rounded-xl p-4 space-y-3">
                                <h3 className="text-sm font-semibold text-text">Supported platforms:</h3>
                                <ul className="space-y-1.5 text-xs text-textMuted">
                                    <li className="flex items-center gap-2"><ExternalLink className="w-3 h-3 text-primary" /> GitHub</li>
                                    <li className="flex items-center gap-2"><ExternalLink className="w-3 h-3 text-primary" /> GitLab</li>
                                    <li className="flex items-center gap-2"><ExternalLink className="w-3 h-3 text-primary" /> Bitbucket</li>
                                    <li className="flex items-center gap-2"><ExternalLink className="w-3 h-3 text-primary" /> Azure DevOps, Codeberg, Gitea, SourceForge</li>
                                </ul>
                            </div>

                            <div className="text-center">
                                <p className="text-xs text-textMuted">
                                    Use the <span className="text-primary font-medium">Settings</span> tab to configure your API key
                                </p>
                            </div>
                        </div>
                    );
                }

                return (
                    <div className="space-y-8 animate-fade-in">
                        <div className="text-center space-y-2 py-6">
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-border mb-4 shadow-inner">
                                <Sparkles className="w-8 h-8 text-primary animate-pulse-slow" />
                            </div>
                            <h2 className="text-2xl font-bold text-text">
                                Welcome to RepoSpector
                            </h2>
                            <p className="text-textMuted max-w-[280px] mx-auto">
                                AI-powered code review, test generation, and repository analysis — all from your browser.
                            </p>
                        </div>

                        {/* Usage Instructions */}
                        <div className="bg-surfaceHighlight/30 border border-border rounded-xl p-4 space-y-3">
                            <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                                <span className="text-primary">📖</span>
                                How to use:
                            </h3>
                            <ol className="space-y-2 text-xs text-textMuted">
                                <li className="flex flex-col gap-1.5">
                                    <span className="flex gap-2">
                                        <span className="text-primary font-semibold shrink-0">1.</span>
                                        <span className="text-text font-medium">Set up: pick the fastest way to a first result</span>
                                    </span>
                                    {keylessRoutes === null ? (
                                        <span className="pl-5 text-textMuted">Checking what's available…</span>
                                    ) : (
                                        <ul className="pl-5 space-y-1.5">
                                            {keylessRoutes.map((route) => (
                                                <li
                                                    key={route.id}
                                                    className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surfaceHighlight/40 px-2 py-1.5"
                                                >
                                                    <span className="min-w-0">
                                                        <span className="block text-text font-medium truncate">{route.label}</span>
                                                        <span className="block text-textMuted">
                                                            <span className={route.tier === 'Ready now' ? 'text-primary font-medium' : ''}>{route.tier}</span>
                                                            {route.detail ? ` — ${route.detail}` : ''}
                                                        </span>
                                                    </span>
                                                    {route.enabled && route.action ? (
                                                        // A real button, not styled text. This read as a
                                                        // button and did nothing, which is worse than
                                                        // omitting it: the panel's whole job is getting
                                                        // someone to a first result, and it was leaving
                                                        // them to find Settings themselves. Every route's
                                                        // next step lives in Settings, so that is where
                                                        // each one goes.
                                                        <button
                                                            type="button"
                                                            onClick={() => setActiveTab('settings')}
                                                            className="shrink-0 text-primary font-medium whitespace-nowrap hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
                                                        >
                                                            {route.action}
                                                        </button>
                                                    ) : null}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                                <li className="flex gap-2">
                                    <span className="text-secondary font-semibold shrink-0">2.</span>
                                    <span><span className="text-text font-medium">Index:</span> Index repositories via the Repos tab for deeper analysis</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="text-primary font-semibold shrink-0">3.</span>
                                    <span><span className="text-text font-medium">Review:</span> Open a PR to get AI code review, or use Chat for test generation and questions</span>
                                </li>
                            </ol>
                        </div>

                        <div className="text-center pt-2 space-y-1.5">
                            <p className="text-xs text-textMuted">
                                Use the{' '}
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('chat')}
                                    className="text-primary font-medium hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded"
                                >
                                    Chat tab
                                </button>
                                {' '}for general questions
                            </p>
                            <p className="text-xs text-textMuted">
                                <a
                                    href={HANDBOOK_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-primary font-medium hover:underline"
                                >
                                    <BookOpen className="w-3 h-3" />
                                    Handbook — features, setup and troubleshooting
                                </a>
                            </p>
                        </div>
                    </div>
                );
        }
    };

    return (
        <>
            <Layout>
                {renderContent()}
            </Layout>
            <TabNavigation
                activeTab={activeTab}
                onTabChange={handleTabChange}
                repoCount={indexedRepoCount}
                isOnPRPage={isOnPRPage}
            />
        </>
    );
}

function App() {
    return (
        <ErrorBoundary fallbackMessage="RepoSpector encountered an error. Please reload the extension and try again.">
            <ThemeProvider>
                <ToastProvider>
                    <AppContent />
                </ToastProvider>
            </ThemeProvider>
        </ErrorBoundary>
    );
}

export default App;

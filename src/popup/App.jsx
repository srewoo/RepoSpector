import React, { useState, useEffect, useCallback } from 'react';
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
import { Sparkles, Code2, FileCode, GitPullRequest, RefreshCw, AlertCircle } from 'lucide-react';

function AppContent() {
    const [activeTab, setActiveTab] = useState('home');
    const [testType, setTestType] = useState(null);
    const [indexedRepoCount, setIndexedRepoCount] = useState(0);

    // PR Review state
    const [prUrl, setPrUrl] = useState(null);
    const [prData, setPrData] = useState(null);
    const [prAnalysisResult, setPrAnalysisResult] = useState(null);
    const [prStaticAnalysisResult, setPrStaticAnalysisResult] = useState(null);
    const [prAiSummary, setPrAiSummary] = useState(null);
    const [prSession, setPrSession] = useState(null);
    const [prLoading, setPrLoading] = useState(false);
    const [prError, setPrError] = useState(null);
    const [isOnPRPage, setIsOnPRPage] = useState(false);

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

    // Detect if on a PR page
    useEffect(() => {
        const checkPRPage = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.url) {
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
                    } else {
                        setIsOnPRPage(false);
                        setPrUrl(null);
                    }
                }
            } catch (error) {
                console.error('Failed to check PR page:', error);
            }
        };

        checkPRPage();
    }, [activeTab]);

    // Analyze PR
    const analyzePR = useCallback(async (focusArea = null) => {
        if (!prUrl) return;

        setPrLoading(true);
        setPrError(null);
        setPrAiSummary(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'ANALYZE_PR_WITH_STATIC_ANALYSIS',
                data: {
                    prUrl,
                    options: {
                        focusAreas: focusArea ? [focusArea] : ['security', 'bugs', 'performance', 'style'],
                        enableESLint: true,
                        enableSemgrep: true,
                        enableDependency: true
                    }
                }
            });

            if (response.success) {
                setPrData(response.data.prData);
                setPrAnalysisResult({
                    analysis: response.data.analysis,
                    recommendation: response.data.staticAnalysis?.recommendation,
                    reviewEffort: response.data.reviewEffort
                });
                setPrStaticAnalysisResult(response.data.staticAnalysis);
                setPrAiSummary(response.data.aiSummary || null);
                // Create a session object for thread management
                setPrSession({
                    sessionId: `pr-${Date.now()}`,
                    prUrl,
                    createdAt: new Date().toISOString()
                });
            } else {
                setPrError(response.error || 'Failed to analyze PR');
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

    // Handle PR refresh
    const handlePRRefresh = useCallback(() => {
        analyzePR();
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
                            // Error state
                            <Card className="p-6 text-center">
                                <AlertCircle className="w-12 h-12 mx-auto text-red-500 mb-3" />
                                <h3 className="text-lg font-medium text-text">Analysis Failed</h3>
                                <p className="text-sm text-textMuted mt-2">{prError}</p>
                                <Button
                                    onClick={handlePRRefresh}
                                    className="mt-4"
                                    disabled={prLoading}
                                >
                                    <RefreshCw className={`w-4 h-4 mr-2 ${prLoading ? 'animate-spin' : ''}`} />
                                    Try Again
                                </Button>
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
                                session={prSession}
                                onRefresh={handlePRRefresh}
                                onAskQuestion={handlePRAskQuestion}
                                onFocusArea={handlePRFocusArea}
                                loading={prLoading}
                            />
                        )}
                    </div>
                );
            case 'home':
            default:
                return (
                    <div className="space-y-8 animate-fade-in">
                        <div className="text-center space-y-2 py-6">
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-border mb-4 shadow-inner">
                                <Sparkles className="w-8 h-8 text-primary animate-pulse-slow" />
                            </div>
                            <h2 className="text-2xl font-bold text-text">
                                Ready to verify?
                            </h2>
                            <p className="text-textMuted max-w-[280px] mx-auto">
                                Navigate to any code file and let AI generate comprehensive test cases for you.
                            </p>
                        </div>

                        {/* Usage Instructions */}
                        <div className="bg-surfaceHighlight/30 border border-border rounded-xl p-4 space-y-3">
                            <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                                <span className="text-primary">📖</span>
                                How to use:
                            </h3>
                            <ol className="space-y-2 text-xs text-textMuted">
                                <li className="flex gap-2">
                                    <span className="text-primary font-semibold shrink-0">1.</span>
                                    <span><span className="text-text font-medium">Configure LLM:</span> Go to Settings tab to add your API key and select a model</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="text-secondary font-semibold shrink-0">2.</span>
                                    <span><span className="text-text font-medium">Index repos:</span> Use the Repos tab to index your repositories for deep context</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="text-primary font-semibold shrink-0">3.</span>
                                    <span><span className="text-text font-medium">Generate tests:</span> Choose test type below or chat with Copilot</span>
                                </li>
                            </ol>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <Card
                                className="group hover:border-primary/50 transition-colors cursor-pointer glass-hover gradient-border"
                                onClick={() => handleGenerateTests('unit')}
                            >
                                <CardContent className="p-4 flex flex-col items-center text-center space-y-3">
                                    <div className="p-2 rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
                                        <Code2 className="w-5 h-5 text-primary" />
                                    </div>
                                    <div>
                                        <h3 className="font-semibold text-sm">Unit Tests</h3>
                                        <p className="text-xs text-textMuted mt-1">Single functions</p>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card
                                className="group hover:border-secondary/50 transition-colors cursor-pointer glass-hover gradient-border"
                                onClick={() => handleGenerateTests('integration')}
                            >
                                <CardContent className="p-4 flex flex-col items-center text-center space-y-3">
                                    <div className="p-2 rounded-lg bg-secondary/10 group-hover:bg-secondary/20 transition-colors">
                                        <FileCode className="w-5 h-5 text-secondary" />
                                    </div>
                                    <div>
                                        <h3 className="font-semibold text-sm">Integration</h3>
                                        <p className="text-xs text-textMuted mt-1">Full flows</p>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        <div className="text-center pt-2">
                            <p className="text-xs text-textMuted">
                                Or use the <span className="text-primary font-medium">Chat tab</span> for general questions
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

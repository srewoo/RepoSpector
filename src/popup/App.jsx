import React, { useState, useEffect } from 'react';
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
import { Sparkles, Code2, FileCode } from 'lucide-react';

function AppContent() {
    const [activeTab, setActiveTab] = useState('home');
    const [testType, setTestType] = useState(null);
    const [indexedRepoCount, setIndexedRepoCount] = useState(0);

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

import React, { useState, useEffect } from 'react';
import { X, Minimize2, Maximize2 } from 'lucide-react';
import { ChatInterface } from '../popup/components/ChatInterface';
import { Settings } from '../popup/components/Settings';
import { Button } from '../popup/components/ui/Button';
import { Card, CardContent } from '../popup/components/ui/Card';
import { Sparkles, Code2, FileCode, GitPullRequest } from 'lucide-react';

// Match GitHub PR, GitLab MR, Bitbucket PR URLs.
const PR_URL_RE = /\/(?:[^/]+\/[^/]+\/(?:pull|pull-requests)\/\d+|.*?\/-\/merge_requests\/\d+)/i;

export function FloatingPanel({ onClose }) {
    const [view, setView] = useState('home'); // 'home', 'settings', 'chat'
    const [testType, setTestType] = useState(null); // 'unit', 'integration', or null
    const [isMinimized, setIsMinimized] = useState(false);
    const [isMaximized, setIsMaximized] = useState(false);
    // Detect PR pages so we can surface a one-click review CTA. The content
    // script runs on the page so window.location is the source of truth.
    const [isPRPage, setIsPRPage] = useState(false);
    const [reviewStatus, setReviewStatus] = useState(null); // null | 'running' | 'done' | 'error'

    useEffect(() => {
        setIsPRPage(typeof window !== 'undefined' && PR_URL_RE.test(window.location?.href ?? ''));
    }, []);

    const handleReviewThisPR = async () => {
        if (reviewStatus === 'running') return;
        setReviewStatus('running');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'ANALYZE_PULL_REQUEST',
                data: {
                    prUrl: window.location.href,
                    options: {
                        contextLevel: 'smart',
                        // Defaults that match the recommended pipeline. These
                        // travel as `options` to the orchestrator branch, which
                        // only kicks in when the user has enabled the flag.
                        focusAreas: ['security', 'bugs', 'performance', 'style'],
                    },
                },
            });
            setReviewStatus(response?.success ? 'done' : 'error');
            // Pop open the popup so the streaming UI is visible. The popup
            // will pick up the same PR via its own page detection.
            try { chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }); } catch { /* best-effort */ }
        } catch {
            setReviewStatus('error');
        }
    };

    const handleSettingsClick = () => {
        setView(view === 'settings' ? 'home' : 'settings');
    };

    const handleGenerateTests = (type) => {
        setTestType(type);
        setView('chat');
    };

    if (isMinimized) {
        return (
            <div className="repospector-floating-minimized">
                <button
                    onClick={() => setIsMinimized(false)}
                    className="repospector-minimize-btn"
                    title="Expand RepoSpector"
                >
                    <Sparkles className="w-5 h-5" />
                    <span className="ml-2">RepoSpector</span>
                </button>
            </div>
        );
    }

    return (
        <div className={`repospector-floating-panel ${isMaximized ? 'repospector-maximized' : ''}`}>
            <div className="repospector-panel-header">
                <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <span className="font-semibold text-text">RepoSpector</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setIsMinimized(true)}
                        className="repospector-icon-btn"
                        title="Minimize"
                    >
                        <Minimize2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setIsMaximized(!isMaximized)}
                        className="repospector-icon-btn"
                        title={isMaximized ? "Restore" : "Maximize"}
                    >
                        <Maximize2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleSettingsClick}
                        className="repospector-icon-btn"
                        title="Settings"
                    >
                        ⚙️
                    </button>
                    <button
                        onClick={onClose}
                        className="repospector-icon-btn repospector-close-btn"
                        title="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="repospector-panel-content">
                {view === 'settings' ? (
                    <Settings onClose={() => setView('home')} />
                ) : view === 'chat' ? (
                    <ChatInterface autoGenerateType={testType} onBack={() => { setView('home'); setTestType(null); }} />
                ) : (
                    <div className="space-y-8 animate-fade-in">
                        <div className="text-center space-y-2 py-8">
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-white/5 mb-4 shadow-inner">
                                <Sparkles className="w-8 h-8 text-primary animate-pulse-slow" />
                            </div>
                            <h2 className="text-2xl font-bold text-text">
                                {isPRPage ? 'PR detected' : 'Ready to verify?'}
                            </h2>
                            <p className="text-textMuted max-w-[280px] mx-auto">
                                {isPRPage
                                    ? 'One click and RepoSpector reviews this PR end-to-end.'
                                    : 'Let AI generate comprehensive test cases for this code.'}
                            </p>
                        </div>

                        {isPRPage && (
                            <Button
                                onClick={handleReviewThisPR}
                                disabled={reviewStatus === 'running'}
                                className="w-full h-12 text-base shadow-xl shadow-primary/20 bg-gradient-to-r from-primary to-indigo-600 hover:from-indigo-500 hover:to-primary transition-all duration-300"
                            >
                                <GitPullRequest className="w-5 h-5 mr-2" />
                                {reviewStatus === 'running' ? 'Reviewing this PR…'
                                    : reviewStatus === 'done' ? 'Reviewed — open popup for findings'
                                    : reviewStatus === 'error' ? 'Review failed — open popup'
                                    : 'Review this PR'}
                            </Button>
                        )}

                        <div className="grid grid-cols-2 gap-4">
                            <Card className="group hover:border-primary/50 transition-colors cursor-pointer glass-hover" onClick={() => handleGenerateTests('unit')}>
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

                            <Card className="group hover:border-secondary/50 transition-colors cursor-pointer glass-hover" onClick={() => handleGenerateTests('integration')}>
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

                        <Button
                            onClick={() => setView('chat')}
                            className="w-full h-12 text-lg shadow-xl shadow-primary/20 bg-gradient-to-r from-primary to-indigo-600 hover:from-indigo-500 hover:to-primary transition-all duration-300"
                        >
                            <Sparkles className="w-5 h-5 mr-2" />
                            Ask Copilot
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

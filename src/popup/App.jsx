import React, { useState } from 'react';
import { Layout } from './components/Layout';
import { Settings } from './components/Settings';
import { ChatInterface } from './components/ChatInterface';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button } from './components/ui/Button';
import { Card, CardContent } from './components/ui/Card';
import { Sparkles, Code2, FileCode } from 'lucide-react';

function App() {
    const [view, setView] = useState('home'); // 'home', 'settings', 'chat'
    const [testType, setTestType] = useState(null); // 'unit', 'integration', or null

    const handleSettingsClick = () => {
        setView(view === 'settings' ? 'home' : 'settings');
    };

    const handleGenerateTests = (type) => {
        setTestType(type);
        setView('chat');
    };

    return (
        <ErrorBoundary fallbackMessage="RepoSpector encountered an error. Please reload the extension and try again.">
            <Layout onSettingsClick={handleSettingsClick}>
            {view === 'settings' ? (
                <Settings onClose={() => setView('home')} />
            ) : view === 'chat' ? (
                <ChatInterface autoGenerateType={testType} onBack={() => { setView('home'); setTestType(null); }} />
            ) : (
                <div className="space-y-8 animate-fade-in">
                    <div className="text-center space-y-2 py-6">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-white/5 mb-4 shadow-inner">
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
                    <div className="bg-surfaceHighlight/30 border border-white/5 rounded-xl p-4 space-y-3">
                        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                            <span className="text-primary">📖</span>
                            How to use:
                        </h3>
                        <ol className="space-y-2 text-xs text-textMuted">
                            <li className="flex gap-2">
                                <span className="text-primary font-semibold shrink-0">1.</span>
                                <span><span className="text-text font-medium">Configure LLM:</span> Click the settings icon (⚙️) to add your API key and select a model</span>
                            </li>
                            <li className="flex gap-2">
                                <span className="text-secondary font-semibold shrink-0">2.</span>
                                <span><span className="text-text font-medium">Choose test type:</span> Click "Unit Tests" for single functions or "Integration" for full flows</span>
                            </li>
                            <li className="flex gap-2">
                                <span className="text-primary font-semibold shrink-0">3.</span>
                                <span><span className="text-text font-medium">Ask Copilot:</span> Chat with AI to explain code, find issues, or get suggestions</span>
                            </li>
                        </ol>
                    </div>

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
            </Layout>
        </ErrorBoundary>
    );
}

export default App;

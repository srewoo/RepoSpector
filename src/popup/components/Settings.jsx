import React, { useState, useEffect } from 'react';
import { Save, Eye, EyeOff, Key, AlertCircle, Cpu, Database, CheckCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { IndexingProgress } from './IndexingProgress';

const LLM_PROVIDERS = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    GROQ: 'groq',
    MISTRAL: 'mistral'
};

const AVAILABLE_MODELS = {
    [LLM_PROVIDERS.OPENAI]: [
        { id: 'openai:gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)', recommended: true },
        { id: 'openai:gpt-4o', name: 'GPT-4o (Best Performance)' },
        { id: 'openai:gpt-4-turbo', name: 'GPT-4 Turbo' }
    ],
    [LLM_PROVIDERS.ANTHROPIC]: [
        { id: 'anthropic:claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Latest)', recommended: true },
        { id: 'anthropic:claude-3-haiku', name: 'Claude 3 Haiku (Fast)' }
    ],
    [LLM_PROVIDERS.GOOGLE]: [
        { id: 'google:gemini-2.0-flash', name: 'Gemini 2.0 Flash (Latest & Fast)', recommended: true },
        { id: 'google:gemini-1.5-pro', name: 'Gemini 1.5 Pro (Premium)' },
        { id: 'google:gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
    ],
    [LLM_PROVIDERS.GROQ]: [
        { id: 'groq:llama-3.3-70b', name: 'Llama 3.3 70B (Latest & Ultra Fast)', recommended: true },
        { id: 'groq:llama3-70b', name: 'Llama 3.1 70B' }
    ],
    [LLM_PROVIDERS.MISTRAL]: [
        { id: 'mistral:mistral-large-latest', name: 'Mistral Large (Latest)', recommended: true },
        { id: 'mistral:mixtral-8x7b', name: 'Mixtral 8x7B' }
    ]
};

export function Settings({ onClose }) {
    const [apiKey, setApiKey] = useState('');
    const [provider, setProvider] = useState(LLM_PROVIDERS.OPENAI);
    const [model, setModel] = useState('openai:gpt-4o-mini');
    const [showKey, setShowKey] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [error, setError] = useState(null);

    // Git platform tokens (for RAG indexing)
    const [githubToken, setGithubToken] = useState('');
    const [gitlabToken, setGitlabToken] = useState('');
    const [showGithubToken, setShowGithubToken] = useState(false);
    const [showGitlabToken, setShowGitlabToken] = useState(false);

    // RAG indexing state
    const [isIndexing, setIsIndexing] = useState(false);
    const [indexProgress, setIndexProgress] = useState(null);
    const [isIndexed, setIsIndexed] = useState(false);
    const [currentRepoUrl, setCurrentRepoUrl] = useState(null);

    // Load settings from background service (with decryption)
    useEffect(() => {
        const loadSettings = async () => {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_SETTINGS'
                });

                if (response.success && response.data) {
                    const settings = response.data;
                    setApiKey(settings.apiKey || '');
                    setGithubToken(settings.githubToken || '');
                    setGitlabToken(settings.gitlabToken || '');

                    // Load model selection
                    if (settings.model) {
                        setModel(settings.model);
                        // Extract provider from model string (e.g., "openai:gpt-4o-mini" -> "openai")
                        const providerFromModel = settings.model.split(':')[0];
                        if (Object.values(LLM_PROVIDERS).includes(providerFromModel)) {
                            setProvider(providerFromModel);
                        }
                    }
                } else {
                    console.warn('Failed to load settings:', response.error);
                }
            } catch (error) {
                console.error('Failed to load settings:', error);
                setError('Failed to load settings. Please try refreshing.');
            }
        };

        loadSettings();
    }, []);

    // Get current tab URL and check indexing status
    useEffect(() => {
        const getCurrentTab = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && (tab.url.includes('github.com') || tab.url.includes('gitlab.com'))) {
                    setCurrentRepoUrl(tab.url);

                    // Check if this repo is already indexed
                    const response = await chrome.runtime.sendMessage({
                        type: 'CHECK_INDEX_STATUS',
                        data: { url: tab.url }
                    });

                    if (response.success) {
                        setIsIndexed(response.isIndexed);
                    }
                }
            } catch (error) {
                console.error('Failed to get current tab:', error);
            }
        };

        getCurrentTab();

        // Listen for indexing progress updates
        const messageListener = (message) => {
            if (message.type === 'INDEX_PROGRESS') {
                setIndexProgress(message.data);
                if (message.data.status === 'complete') {
                    setIsIndexing(false);
                    setIsIndexed(true);
                } else if (message.data.status === 'error') {
                    setIsIndexing(false);
                }
            }
        };

        chrome.runtime.onMessage.addListener(messageListener);
        return () => chrome.runtime.onMessage.removeListener(messageListener);
    }, []);

    // Update model when provider changes
    useEffect(() => {
        const modelsForProvider = AVAILABLE_MODELS[provider];
        if (modelsForProvider && modelsForProvider.length > 0) {
            // Select the recommended model or the first one
            const recommended = modelsForProvider.find(m => m.recommended);
            setModel(recommended ? recommended.id : modelsForProvider[0].id);
        }
    }, [provider]);

    const handleSave = async () => {
        setIsLoading(true);
        setIsSaved(false);
        setError(null);

        try {
            // Validate API key
            if (!apiKey || apiKey.trim() === '') {
                throw new Error('API key is required');
            }

            // Send to background service for encryption and storage
            const response = await chrome.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                data: {
                    settings: {
                        apiKey: apiKey,
                        model: model,
                        provider: provider,
                        githubToken: githubToken,
                        gitlabToken: gitlabToken
                    }
                }
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to save settings');
            }

            setIsLoading(false);
            setIsSaved(true);

            // Auto-close after success
            setTimeout(() => {
                onClose();
            }, 1500);
        } catch (error) {
            console.error('Save failed:', error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Failed to save settings. Please try again.';
            setError(errMsg);
            setIsLoading(false);
        }
    };

    const getProviderLabel = (provider) => {
        const labels = {
            [LLM_PROVIDERS.OPENAI]: 'OpenAI',
            [LLM_PROVIDERS.ANTHROPIC]: 'Anthropic',
            [LLM_PROVIDERS.GOOGLE]: 'Google AI',
            [LLM_PROVIDERS.GROQ]: 'Groq (Ultra Fast)',
            [LLM_PROVIDERS.MISTRAL]: 'Mistral AI'
        };
        return labels[provider] || provider;
    };

    const getKeyPlaceholder = () => {
        const placeholders = {
            [LLM_PROVIDERS.OPENAI]: 'sk-...',
            [LLM_PROVIDERS.ANTHROPIC]: 'sk-ant-...',
            [LLM_PROVIDERS.GOOGLE]: 'AIza...',
            [LLM_PROVIDERS.GROQ]: 'gsk_...',
            [LLM_PROVIDERS.MISTRAL]: 'xxx...'
        };
        return placeholders[provider] || 'Enter API key';
    };

    const handleIndexRepository = async () => {
        if (!currentRepoUrl) {
            setError('No repository detected. Please navigate to a GitHub or GitLab repository.');
            return;
        }

        if (!apiKey || apiKey.trim() === '') {
            setError('Please save your API key first. API key is required for generating embeddings.');
            return;
        }

        setIsIndexing(true);
        setIndexProgress({ status: 'starting', message: 'Initializing...' });
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'INDEX_REPOSITORY',
                data: { url: currentRepoUrl }
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to index repository');
            }

            // Success handled by message listener
        } catch (error) {
            console.error('Indexing error:', error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Failed to index repository';
            setError(errMsg);
            setIsIndexing(false);
            setIndexProgress({ status: 'error', message: errMsg });
        }
    };

    const handleClearIndex = async () => {
        if (!currentRepoUrl) return;

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'CLEAR_INDEX',
                data: { url: currentRepoUrl }
            });

            if (response.success) {
                setIsIndexed(false);
                setIndexProgress(null);
            }
        } catch (error) {
            console.error('Failed to clear index:', error);
            setError('Failed to clear index');
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-text">Settings</h2>
                <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            </div>

            {/* Error Display */}
            {error && (
                <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            )}

            {/* LLM Provider Selection */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Cpu className="w-4 h-4 text-primary" />
                        LLM Provider
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-textMuted">
                        Choose your AI model provider
                    </p>
                    <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                        className="w-full h-10 px-3 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                    >
                        {Object.values(LLM_PROVIDERS).map(prov => (
                            <option key={prov} value={prov}>
                                {getProviderLabel(prov)}
                            </option>
                        ))}
                    </select>
                </CardContent>
            </Card>

            {/* Model Selection */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Cpu className="w-4 h-4 text-secondary" />
                        Model
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-textMuted">
                        Select the model to use for code analysis and test generation
                    </p>
                    <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full h-10 px-3 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                    >
                        {AVAILABLE_MODELS[provider].map(m => (
                            <option key={m.id} value={m.id}>
                                {m.name} {m.recommended ? '⭐' : ''}
                            </option>
                        ))}
                    </select>
                </CardContent>
            </Card>

            {/* API Key */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Key className="w-4 h-4 text-primary" />
                        {getProviderLabel(provider)} API Key
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-textMuted">
                        Required for {getProviderLabel(provider)} model access
                    </p>
                    <div className="relative">
                        <input
                            type={showKey ? 'text' : 'password'}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={getKeyPlaceholder()}
                            className="w-full h-10 px-3 pr-10 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-white/20"
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                        >
                            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                    <p className="text-xs text-textMuted">
                        Get your API key from:{' '}
                        {provider === LLM_PROVIDERS.OPENAI && (
                            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                OpenAI Platform
                            </a>
                        )}
                        {provider === LLM_PROVIDERS.ANTHROPIC && (
                            <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Anthropic Console
                            </a>
                        )}
                        {provider === LLM_PROVIDERS.GOOGLE && (
                            <a href="https://makersuite.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Google AI Studio
                            </a>
                        )}
                        {provider === LLM_PROVIDERS.GROQ && (
                            <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Groq Console
                            </a>
                        )}
                        {provider === LLM_PROVIDERS.MISTRAL && (
                            <a href="https://console.mistral.ai/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Mistral Console
                            </a>
                        )}
                    </p>
                </CardContent>
            </Card>

            {/* GitHub Token (Optional - for private repos and rate limits) */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Key className="w-4 h-4 text-purple-400" />
                        GitHub Token (Optional)
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-textMuted">
                        Required for private repos and avoids GitHub rate limits (60 req/hour → 5000 req/hour)
                    </p>
                    <div className="relative">
                        <input
                            type={showGithubToken ? 'text' : 'password'}
                            value={githubToken}
                            onChange={(e) => setGithubToken(e.target.value)}
                            placeholder="ghp_..."
                            className="w-full h-10 px-3 pr-10 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-white/20"
                        />
                        <button
                            type="button"
                            onClick={() => setShowGithubToken(!showGithubToken)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                        >
                            {showGithubToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                    <div className="text-xs text-textMuted space-y-1">
                        <p>
                            Get your token from:{' '}
                            <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitHub Settings
                            </a>
                        </p>
                        <p className="text-yellow-500/80">
                            💡 Tip: Create a "Personal Access Token (Classic)" with "repo" scope
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* GitLab Token (Optional - for private repos) */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Key className="w-4 h-4 text-orange-400" />
                        GitLab Token (Optional)
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-textMuted">
                        Required for private GitLab repositories
                    </p>
                    <div className="relative">
                        <input
                            type={showGitlabToken ? 'text' : 'password'}
                            value={gitlabToken}
                            onChange={(e) => setGitlabToken(e.target.value)}
                            placeholder="glpat-..."
                            className="w-full h-10 px-3 pr-10 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-white/20"
                        />
                        <button
                            type="button"
                            onClick={() => setShowGitlabToken(!showGitlabToken)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                        >
                            {showGitlabToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                    <div className="text-xs text-textMuted space-y-1">
                        <p>
                            Get your token from:{' '}
                            <a href="https://gitlab.com/-/profile/personal_access_tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitLab Settings
                            </a>
                        </p>
                        <p className="text-yellow-500/80">
                            💡 Tip: Create a token with "read_api" and "read_repository" scopes
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* Repository Indexing (RAG) */}
            {currentRepoUrl && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Database className="w-4 h-4 text-primary" />
                            Repository Context (RAG)
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-textMuted">
                            Index this repository to enable Deep Context (RAG). When enabled in chat, AI can search your entire codebase for relevant context, providing more accurate responses about dependencies, patterns, and architecture.
                        </p>

                        <div className="flex items-start gap-2 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                            <AlertCircle className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                            <div className="text-xs text-blue-300">
                                <p className="font-medium">What's Deep Context (RAG)?</p>
                                <p className="text-blue-300/80 mt-1">
                                    Deep Context uses Retrieval-Augmented Generation (RAG) to search your indexed repository and find semantically similar code. This is separate from context levels (minimal/smart/full) which only analyze visible code.
                                </p>
                            </div>
                        </div>

                        {/* Token requirement notice */}
                        {!githubToken && currentRepoUrl?.includes('github.com') && (
                            <div className="flex items-start gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                                <div className="text-xs text-yellow-500">
                                    <p className="font-medium">GitHub token recommended</p>
                                    <p className="text-yellow-500/80 mt-1">
                                        Without a token, you're limited to 60 API requests/hour. Add a GitHub token above to increase to 5000/hour.
                                    </p>
                                </div>
                            </div>
                        )}
                        {!gitlabToken && currentRepoUrl?.includes('gitlab.com') && (
                            <div className="flex items-start gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                                <div className="text-xs text-yellow-500">
                                    <p className="font-medium">GitLab token may be required</p>
                                    <p className="text-yellow-500/80 mt-1">
                                        If this is a private repository, you need to add a GitLab token above.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Index Status */}
                        {isIndexed && !isIndexing && (
                            <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
                                <CheckCircle className="w-4 h-4 text-green-500" />
                                <span className="text-sm text-green-500">Repository indexed</span>
                            </div>
                        )}

                        {/* Progress */}
                        {isIndexing && indexProgress && (
                            <IndexingProgress progress={indexProgress} />
                        )}

                        {/* Actions */}
                        <div className="flex gap-2">
                            <Button
                                onClick={handleIndexRepository}
                                disabled={isIndexing || !apiKey}
                                isLoading={isIndexing}
                                className="flex-1"
                            >
                                <Database className="w-4 h-4 mr-2" />
                                {isIndexed ? 'Re-index Repository' : 'Index Repository'}
                            </Button>
                            {isIndexed && !isIndexing && (
                                <Button
                                    onClick={handleClearIndex}
                                    variant="outline"
                                    className="px-3"
                                >
                                    Clear
                                </Button>
                            )}
                        </div>

                        <p className="text-xs text-textMuted">
                            💡 Tip: Indexing takes 2-5 minutes for medium repos. Deep context will be available after indexing completes.
                        </p>
                    </CardContent>
                </Card>
            )}

            <div className="flex justify-end pt-4">
                <Button onClick={handleSave} isLoading={isLoading} className="w-full sm:w-auto">
                    <Save className="w-4 h-4 mr-2" />
                    {isSaved ? 'Saved!' : 'Save Settings'}
                </Button>
            </div>
        </div>
    );
}

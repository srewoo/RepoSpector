import React, { useState, useEffect } from 'react';
import { Save, Eye, EyeOff, Key, AlertCircle, CheckCircle, Cpu, Sun, Moon, Palette, Github, GitBranch } from 'lucide-react';
import { Button } from './ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Collapsible } from './ui/Collapsible';
import { useTheme } from '../contexts/ThemeContext';

const LLM_PROVIDERS = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    GROQ: 'groq',
    MISTRAL: 'mistral',
    LOCAL: 'local'  // Ollama
};

const AVAILABLE_MODELS = {
    [LLM_PROVIDERS.OPENAI]: [
        { id: 'openai:gpt-4o', name: 'GPT-4o (Latest Flagship)', recommended: true },
        { id: 'openai:gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)' },
        { id: 'openai:o1-mini', name: 'o1-mini (Reasoning)' }
    ],
    [LLM_PROVIDERS.ANTHROPIC]: [
        { id: 'anthropic:claude-sonnet-4', name: 'Claude Sonnet 4 (Latest)', recommended: true },
        { id: 'anthropic:claude-3.5-haiku', name: 'Claude 3.5 Haiku (Fast)' },
        { id: 'anthropic:claude-opus-4', name: 'Claude Opus 4 (Most Capable)' }
    ],
    [LLM_PROVIDERS.GOOGLE]: [
        { id: 'google:gemini-2.0-flash', name: 'Gemini 2.0 Flash (Latest)', recommended: true },
        { id: 'google:gemini-2.0-pro', name: 'Gemini 2.0 Pro (Premium)' },
        { id: 'google:gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite (Fastest)' }
    ],
    [LLM_PROVIDERS.GROQ]: [
        { id: 'groq:llama-3.3-70b', name: 'Llama 3.3 70B (Ultra Fast)', recommended: true },
        { id: 'groq:deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 70B (Reasoning)' },
        { id: 'groq:mixtral-8x7b', name: 'Mixtral 8x7B (Balanced)' }
    ],
    [LLM_PROVIDERS.MISTRAL]: [
        { id: 'mistral:mistral-large', name: 'Mistral Large 2 (Latest)', recommended: true },
        { id: 'mistral:codestral', name: 'Codestral (Code-focused)' },
        { id: 'mistral:mistral-small', name: 'Mistral Small (Fast)' }
    ],
    [LLM_PROVIDERS.LOCAL]: [
        { id: 'local:llama3.3', name: 'Llama 3.3 (Latest)', recommended: true },
        { id: 'local:deepseek-coder-v2', name: 'DeepSeek Coder V2' },
        { id: 'local:qwen2.5-coder', name: 'Qwen 2.5 Coder (32B)' }
    ]
};

export function Settings({ onClose }) {
    const { theme, toggleTheme } = useTheme();
    const [apiKey, setApiKey] = useState('');
    const [provider, setProvider] = useState(LLM_PROVIDERS.OPENAI);
    const [model, setModel] = useState('openai:gpt-4o-mini');
    const [showKey, setShowKey] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [error, setError] = useState(null);
    const [hasExistingKey, setHasExistingKey] = useState(false);

    // Git platform tokens (for RAG indexing)
    const [githubToken, setGithubToken] = useState('');
    const [gitlabToken, setGitlabToken] = useState('');
    const [showGithubToken, setShowGithubToken] = useState(false);
    const [showGitlabToken, setShowGitlabToken] = useState(false);

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
                    setHasExistingKey(!!settings.apiKey);
                    setGithubToken(settings.githubToken || '');
                    setGitlabToken(settings.gitlabToken || '');

                    // Load model selection
                    if (settings.model && typeof settings.model === 'string') {
                        // Check if model has provider prefix (e.g., "openai:gpt-4o")
                        if (settings.model.includes(':')) {
                            const providerFromModel = settings.model.split(':')[0];
                            if (Object.values(LLM_PROVIDERS).includes(providerFromModel)) {
                                setProvider(providerFromModel);
                                setModel(settings.model);
                            } else {
                                // Unknown provider, use default
                                setProvider(LLM_PROVIDERS.OPENAI);
                                setModel('openai:gpt-4o');
                            }
                        } else {
                            // Legacy model without provider prefix, default to OpenAI
                            setProvider(LLM_PROVIDERS.OPENAI);
                            setModel('openai:gpt-4o');
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
            // Validate API key (not required for local/Ollama)
            const isLocal = provider === LLM_PROVIDERS.LOCAL;
            if (!isLocal && (!apiKey || apiKey.trim() === '')) {
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
            [LLM_PROVIDERS.MISTRAL]: 'Mistral AI',
            [LLM_PROVIDERS.LOCAL]: 'Ollama (Local)'
        };
        return labels[provider] || provider;
    };

    const isLocalProvider = provider === LLM_PROVIDERS.LOCAL;

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

    return (
        <div className="space-y-4 animate-fade-in">
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

            {/* API Key Status Indicator */}
            {hasExistingKey && (
                <div className="flex items-center gap-2 px-3 py-2 bg-success/10 border border-success/20 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span className="text-sm text-success">API key configured</span>
                </div>
            )}

            {/* Appearance Section */}
            <Collapsible title="Appearance" icon={Palette} defaultOpen={true}>
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <p className="text-sm font-medium text-text">Theme</p>
                        <p className="text-xs text-textMuted">
                            Switch between dark and light mode
                        </p>
                    </div>
                    <button
                        onClick={toggleTheme}
                        className="relative flex items-center gap-2 h-10 px-4 bg-surfaceHighlight border border-border rounded-lg hover:bg-surfaceHighlight/80 transition-colors"
                    >
                        {theme === 'dark' ? (
                            <>
                                <Moon className="w-4 h-4 text-primary" />
                                <span className="text-sm">Dark</span>
                            </>
                        ) : (
                            <>
                                <Sun className="w-4 h-4 text-warning" />
                                <span className="text-sm">Light</span>
                            </>
                        )}
                    </button>
                </div>
            </Collapsible>

            {/* AI Configuration Section */}
            <Collapsible
                title="AI Configuration"
                icon={Cpu}
                defaultOpen={true}
                badge={getProviderLabel(provider)}
            >
                <div className="space-y-4">
                    {/* LLM Provider */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text">Provider</label>
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
                    </div>

                    {/* Model Selection */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text">Model</label>
                        <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-white/10 rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            {(AVAILABLE_MODELS[provider] || []).map(m => (
                                <option key={m.id} value={m.id}>
                                    {m.name} {m.recommended ? '⭐' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* API Key (not shown for Ollama) */}
                    {!isLocalProvider ? (
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-text">
                                {getProviderLabel(provider)} API Key
                            </label>
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
                                Get your key from:{' '}
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
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex items-start gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                                <CheckCircle className="w-4 h-4 text-success mt-0.5" />
                                <div className="text-sm text-success">
                                    <p className="font-medium">No API key required!</p>
                                    <p className="text-xs text-success/80 mt-1">
                                        Ollama runs locally for 100% privacy.
                                    </p>
                                </div>
                            </div>
                            <div className="text-xs text-textMuted space-y-2">
                                <p className="font-medium">Quick setup:</p>
                                <ol className="list-decimal list-inside space-y-1 ml-2">
                                    <li>Install from <a href="https://ollama.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ollama.ai</a></li>
                                    <li>Run: <code className="bg-surfaceHighlight px-1 py-0.5 rounded">ollama pull llama3.3</code></li>
                                    <li>Start: <code className="bg-surfaceHighlight px-1 py-0.5 rounded">ollama serve</code></li>
                                </ol>
                            </div>
                        </div>
                    )}
                </div>
            </Collapsible>

            {/* Git Platform Tokens Section */}
            <Collapsible
                title="Git Platform Tokens"
                icon={GitBranch}
                defaultOpen={false}
                badge="Optional"
            >
                <div className="space-y-4">
                    {/* GitHub Token */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">GitHub Token</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Private repos + higher rate limits
                            </span>
                        </div>
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
                        <p className="text-xs text-textMuted">
                            Get from:{' '}
                            <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitHub Settings
                            </a>
                            {' '}- Use "repo" scope
                        </p>
                    </div>

                    {/* GitLab Token */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">GitLab Token</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Private repos
                            </span>
                        </div>
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
                        <p className="text-xs text-textMuted">
                            Get from:{' '}
                            <a href="https://gitlab.com/-/profile/personal_access_tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitLab Settings
                            </a>
                            {' '}- Use "read_api" scope
                        </p>
                    </div>
                </div>
            </Collapsible>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
                <Button onClick={handleSave} isLoading={isLoading} className="w-full sm:w-auto">
                    <Save className="w-4 h-4 mr-2" />
                    {isSaved ? 'Saved!' : 'Save Settings'}
                </Button>
            </div>
        </div>
    );
}

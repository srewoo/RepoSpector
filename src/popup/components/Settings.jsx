import React, { useState, useEffect } from 'react';
import { Save, Eye, EyeOff, Key, AlertCircle, Cpu } from 'lucide-react';
import { Button } from './ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';

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
                        provider: provider
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
            setError(error.message || 'Failed to save settings. Please try again.');
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

            <div className="flex justify-end pt-4">
                <Button onClick={handleSave} isLoading={isLoading} className="w-full sm:w-auto">
                    <Save className="w-4 h-4 mr-2" />
                    {isSaved ? 'Saved!' : 'Save Settings'}
                </Button>
            </div>
        </div>
    );
}

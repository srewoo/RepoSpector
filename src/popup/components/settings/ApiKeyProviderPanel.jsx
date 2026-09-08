import React, { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { LLM_PROVIDERS } from '../../../utils/constants.js';
import { KeyTestVerdict } from './KeyTestVerdict.jsx';
import { getProviderLabel } from './providerLabels.js';

function getKeyPlaceholder(provider) {
    const placeholders = {
        [LLM_PROVIDERS.OPENAI]: 'sk-...',
        [LLM_PROVIDERS.ANTHROPIC]: 'sk-ant-...',
        [LLM_PROVIDERS.GOOGLE]: 'AIza...',
        [LLM_PROVIDERS.GROQ]: 'gsk_...',
        [LLM_PROVIDERS.MISTRAL]: 'xxx...',
        [LLM_PROVIDERS.OPENROUTER]: 'sk-or-v1-...',
        [LLM_PROVIDERS.NVIDIA]: 'nvapi-...'
    };
    return placeholders[provider] || 'Enter API key';
}

/**
 * The single-API-key credential panel used by every provider that isn't
 * Bedrock and isn't keyless. The registry (`providerPanelRegistry.js`) routes
 * Bedrock to `BedrockPanel`, and Ollama / Chrome built-in AI to their own
 * panels (`OllamaPanel.jsx`, `ChromeAIPanel.jsx`), so this component is only
 * ever reached for a keyed, non-Bedrock provider — it renders exactly the
 * API-key block below and nothing else.
 */
export function ApiKeyProviderPanel({ provider, apiKey, setApiKey, keyTest, keyTesting, testApiKey, refreshModels }) {
    const [showKey, setShowKey] = useState(false);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text">
                    {getProviderLabel(provider)} API Key
                </label>
                <button
                    type="button"
                    onClick={testApiKey}
                    disabled={keyTesting}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                    title="Send one tiny request to the selected model to check the key really works"
                >
                    {keyTesting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {keyTesting ? 'Testing…' : 'Test key'}
                </button>
            </div>
            <div className="relative">
                <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onBlur={() => { if (apiKey && apiKey.trim().length > 10) refreshModels(); }}
                    placeholder={getKeyPlaceholder(provider)}
                    className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
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
                {provider === LLM_PROVIDERS.OPENROUTER && (
                    <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        OpenRouter Keys
                    </a>
                )}
                {provider === LLM_PROVIDERS.NVIDIA && (
                    <a href="https://build.nvidia.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        NVIDIA Build (API Catalog)
                    </a>
                )}
            </p>
            <KeyTestVerdict result={keyTest} />
        </div>
    );
}

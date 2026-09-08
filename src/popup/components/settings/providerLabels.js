import { LLM_PROVIDERS } from '../../../utils/constants.js';

/** Human-readable label for a provider id. Shared by Settings.jsx (provider
 * badge, provider <select>, model-count caption) and ApiKeyProviderPanel.jsx
 * (API key field label), so it exists in exactly one place. */
export function getProviderLabel(provider) {
    const labels = {
        [LLM_PROVIDERS.OPENAI]: 'OpenAI',
        [LLM_PROVIDERS.ANTHROPIC]: 'Anthropic',
        [LLM_PROVIDERS.GOOGLE]: 'Google AI',
        [LLM_PROVIDERS.GROQ]: 'Groq (Ultra Fast)',
        [LLM_PROVIDERS.MISTRAL]: 'Mistral AI',
        [LLM_PROVIDERS.OPENROUTER]: 'OpenRouter',
        [LLM_PROVIDERS.NVIDIA]: 'NVIDIA NIM',
        [LLM_PROVIDERS.BEDROCK]: 'AWS Bedrock',
        [LLM_PROVIDERS.LOCAL]: 'Ollama (Local)',
        [LLM_PROVIDERS.CHROME_AI]: 'Chrome built-in AI (no key)'
    };
    return labels[provider] || provider;
}

import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import type { ModelProvider } from './types.js';

export { estimateCost, PRESETS, PRICES_AS_OF, type ModelChoice, type Preset } from './presets.js';
export { OLLAMA_URL } from './ollama.js';
export { ProviderError, type CompletionRequest, type CompletionResult, type Effort, type ModelProvider, type ProviderId } from './types.js';

export type ProviderConfig =
  | { readonly id: 'anthropic' | 'openai' | 'gemini'; readonly apiKey: string; readonly model: string; readonly fetchImpl?: typeof fetch; readonly maxRetries?: number }
  | { readonly id: 'ollama'; readonly model: string; readonly baseUrl?: string; readonly fetchImpl?: typeof fetch };

export function createProvider(c: ProviderConfig): ModelProvider {
  switch (c.id) {
    case 'anthropic':
      return new AnthropicProvider(c.apiKey, c.model, { ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}), ...(c.maxRetries !== undefined ? { maxRetries: c.maxRetries } : {}) });
    case 'openai':
      return new OpenAIProvider(c.apiKey, c.model, c.fetchImpl);
    case 'gemini':
      return new GeminiProvider(c.apiKey, c.model, c.fetchImpl);
    case 'ollama':
      return new OllamaProvider(c.model, c.fetchImpl, c.baseUrl);
  }
}

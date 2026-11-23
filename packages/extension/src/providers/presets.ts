import type { ProviderId } from './types.js';

export type Preset = 'best' | 'balanced' | 'low';

export interface ModelChoice {
  readonly model: string;
  /** USD per million input / output tokens, standard tier. */
  readonly inPerM: number;
  readonly outPerM: number;
}

/**
 * Prices from each provider's pricing page on this date. They change: the cost estimate shows the
 * date. Gemini 4 Carbon's listed rate rises to $4 / $20 after 2026-11-30. OpenAI tiers are inferred
 * from names and prices (the page does not label them).
 */
export const PRICES_AS_OF = '2026-11-21';

export const PRESETS: Record<Exclude<ProviderId, 'ollama'>, Record<Preset, ModelChoice>> = {
  anthropic: {
    best: { model: 'claude-opus-5-5', inPerM: 4, outPerM: 20 },
    balanced: { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10 },
    low: { model: 'claude-haiku-5-5', inPerM: 0.1, outPerM: 0.5 },
  },
  openai: {
    best: { model: 'gpt-6.2-astra', inPerM: 8, outPerM: 40 },
    balanced: { model: 'gpt-6.2-sol', inPerM: 2, outPerM: 10 },
    low: { model: 'gpt-6-luna', inPerM: 0.1, outPerM: 0.5 },
  },
  gemini: {
    best: { model: 'gemini-4-carbon', inPerM: 2, outPerM: 10 },
    balanced: { model: 'gemini-4-hydrogen', inPerM: 1.5, outPerM: 7.5 },
    low: { model: 'gemini-3.5-flash-lite', inPerM: 0.3, outPerM: 2.5 },
  },
};

export function estimateCost(choice: ModelChoice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * choice.inPerM + outputTokens * choice.outPerM) / 1_000_000;
}

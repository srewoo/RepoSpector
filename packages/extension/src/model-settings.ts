import * as z from 'zod/mini';
import { PRESETS, type ModelChoice, type Preset } from './providers/presets.js';
import type { ProviderId } from './providers/types.js';

/** Model ids: letters, digits and . _ : - only, so they cannot alter a URL path or query. */
const ModelId = z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/));

export const ModelSettingsSchema = z.strictObject({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
  preset: z.enum(['best', 'balanced', 'low']),
  /** The model picked from the provider's list (or typed); overrides the preset. */
  customModel: z.optional(ModelId),
  ollamaModel: z.optional(ModelId),
  /** Where Ollama listens; localhost only (any port), so a setting cannot point the extension elsewhere. */
  ollamaUrl: z.optional(z.string().check(z.regex(/^http:\/\/localhost:\d{1,5}$/))),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export interface ResolvedModel {
  readonly provider: ProviderId;
  readonly model: string;
  /** Null when the price is unknown (custom model id). */
  readonly prices: ModelChoice | null;
}

export function resolveModel(s: ModelSettings): ResolvedModel {
  if (s.provider === 'ollama') {
    if (!s.ollamaModel) throw new Error('choose an Ollama model you have pulled, e.g. qwen3:32b');
    return { provider: 'ollama', model: s.ollamaModel, prices: { model: s.ollamaModel, inPerM: 0, outPerM: 0 } };
  }
  if (s.customModel) {
    // A picked model that is one of the presets keeps its dated price.
    const known = (Object.values(PRESETS[s.provider]) as ModelChoice[]).find((c) => c.model === s.customModel);
    return { provider: s.provider, model: s.customModel, prices: known ?? null };
  }
  const choice = PRESETS[s.provider][s.preset as Preset];
  return { provider: s.provider, model: choice.model, prices: choice };
}

const ORIGINS: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com/*',
  openai: 'https://api.openai.com/*',
  gemini: 'https://generativelanguage.googleapis.com/*',
  // Match patterns without a port match every port; Ollama listens on 11434.
  ollama: 'http://localhost/*',
};

export function providerOrigins(id: ProviderId): string[] {
  return [ORIGINS[id]];
}

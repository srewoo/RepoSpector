import { describe, expect, it } from 'vitest';
import { providerOrigins, resolveModel, ModelSettingsSchema } from '../src/model-settings.js';

describe('model settings', () => {
  it('resolves a preset to its model and dated prices', () => {
    expect(resolveModel({ provider: 'anthropic', preset: 'balanced' })).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', prices: { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10 } });
  });

  it('a custom model id overrides the preset and has no known price', () => {
    expect(resolveModel({ provider: 'openai', preset: 'best', customModel: 'gpt-6.2-astra-2026-10' })).toEqual({ provider: 'openai', model: 'gpt-6.2-astra-2026-10', prices: null });
  });

  it('Ollama uses the named local model at zero cost, and needs one', () => {
    expect(resolveModel({ provider: 'ollama', preset: 'best', ollamaModel: 'qwen3:32b' })).toEqual({ provider: 'ollama', model: 'qwen3:32b', prices: { model: 'qwen3:32b', inPerM: 0, outPerM: 0 } });
    expect(() => resolveModel({ provider: 'ollama', preset: 'best' })).toThrow(/Ollama model/);
  });

  it('asks only for the chosen provider\'s API origin', () => {
    expect(providerOrigins('anthropic')).toEqual(['https://api.anthropic.com/*']);
    expect(providerOrigins('gemini')).toEqual(['https://generativelanguage.googleapis.com/*']);
    expect(providerOrigins('ollama')).toEqual(['http://localhost/*']);
  });

  it('accepts an Ollama address on localhost only', () => {
    expect(ModelSettingsSchema.safeParse({ provider: 'ollama', preset: 'low', ollamaModel: 'qwen3', ollamaUrl: 'http://localhost:11500' }).success).toBe(true);
    for (const bad of ['http://evil.example:11434', 'https://localhost:11434', 'http://localhost:11434/api', 'http://127.0.0.1.evil.example:1']) {
      expect(ModelSettingsSchema.safeParse({ provider: 'ollama', preset: 'low', ollamaModel: 'qwen3', ollamaUrl: bad }).success).toBe(false);
    }
  });

  it('rejects unsafe model ids and unknown fields', () => {
    expect(ModelSettingsSchema.safeParse({ provider: 'anthropic', preset: 'best', customModel: 'x y' }).success).toBe(false);
    expect(ModelSettingsSchema.safeParse({ provider: 'anthropic', preset: 'best', extra: 1 }).success).toBe(false);
    expect(ModelSettingsSchema.safeParse({ provider: 'ollama', preset: 'low', ollamaModel: 'llama3.3:70b-instruct-q4_K_M' }).success).toBe(true);
  });
});

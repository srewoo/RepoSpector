import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/providers/index.js';

// Opt-in: LIVE_OLLAMA=<model> npx vitest run packages/extension/test/live-ollama.test.ts
const model = process.env.LIVE_OLLAMA;

describe.skipIf(!model)('Ollama provider against a real local server', () => {
  it('returns text and token counts', async () => {
    const r = await createProvider({ id: 'ollama', model: model ?? '' }).complete({ system: 'Reply with the single word OK.', prompt: 'ping', maxTokens: 16 });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.stop === 'end' || r.stop === 'max_tokens').toBe(true);
    console.log('live ollama:', JSON.stringify(r));
  }, 120_000);
});

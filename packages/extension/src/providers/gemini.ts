import { postJson } from './http.js';
import type { CompletionRequest, CompletionResult, ModelProvider } from './types.js';

interface GenerateReply {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,80}$/;
const BLOCKED = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION']);

/** Gemini generateContent. The key goes in the x-goog-api-key header, never in the URL. */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!MODEL_ID.test(model)) throw new Error('invalid Gemini model id');
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: { maxOutputTokens: req.maxTokens, ...(req.effort ? { thinkingConfig: { thinkingLevel: req.effort.toUpperCase() } } : {}) },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const r = (await postJson(this.fetchImpl, 'Gemini', url, { 'x-goog-api-key': this.apiKey }, body, req.signal)) as GenerateReply;
    const cand = r.candidates?.[0];
    const text = (cand?.content?.parts ?? []).flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join('');
    const finish = cand?.finishReason;
    const stop = r.promptFeedback?.blockReason || (finish && BLOCKED.has(finish)) ? 'refusal' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'STOP' ? 'end' : 'other';
    const u = r.usageMetadata ?? {};
    return { text, model: r.modelVersion ?? this.model, usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) }, stop, fallbackUsed: false };
  }
}

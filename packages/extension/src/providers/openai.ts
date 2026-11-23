import { postJson } from './http.js';
import type { CompletionRequest, CompletionResult, ModelProvider } from './types.js';

interface ResponsesReply {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** OpenAI Responses API (POST /v1/responses). `store: false` so the review is not kept server-side for later turns. */
export class OpenAIProvider implements ModelProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = { model: this.model, ...(req.system ? { instructions: req.system } : {}), input: req.prompt, max_output_tokens: req.maxTokens, ...(req.effort ? { reasoning: { effort: req.effort } } : {}), store: false };
    const r = (await postJson(this.fetchImpl, 'OpenAI', 'https://api.openai.com/v1/responses', { authorization: `Bearer ${this.apiKey}` }, body, req.signal)) as ResponsesReply;
    const parts = (r.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    const refused = parts.some((p) => p.type === 'refusal');
    const text = parts.flatMap((p) => (p.type === 'output_text' && p.text ? [p.text] : [])).join('');
    const stop = refused ? 'refusal' : r.status === 'incomplete' ? (r.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : r.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'other') : 'end';
    return { text, model: r.model ?? this.model, usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 }, stop, fallbackUsed: false };
  }
}

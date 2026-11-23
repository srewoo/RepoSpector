import { postJson } from './http.js';
import type { CompletionRequest, CompletionResult, ModelProvider } from './types.js';

export const OLLAMA_URL = 'http://localhost:11434';

interface ChatReply {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** A local Ollama server. No key; nothing leaves the machine. */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;

  constructor(
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = OLLAMA_URL,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = { model: this.model, stream: false, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }], options: { num_predict: req.maxTokens } };
    const hint = `Check that Ollama is running at ${this.baseUrl} and that it allows this extension: start it with OLLAMA_ORIGINS=chrome-extension://* (see Ollama's docs on allowed origins).`;
    const r = (await postJson(this.fetchImpl, 'Ollama', `${this.baseUrl}/api/chat`, {}, body, req.signal, hint)) as ChatReply;
    const stop = r.done_reason === 'stop' ? 'end' : r.done_reason === 'length' ? 'max_tokens' : 'other';
    return { text: r.message?.content ?? '', model: r.model ?? this.model, usage: { inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0 }, stop, fallbackUsed: false };
  }
}

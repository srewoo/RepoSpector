export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama';
export type Effort = 'low' | 'medium' | 'high';

export interface CompletionRequest {
  /** Omitted when unset: the measured prompts were sent as one user message with no system prompt. */
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly effort?: Effort;
  readonly signal?: AbortSignal;
}

export interface CompletionResult {
  readonly text: string;
  /** The model that actually answered (differs from the requested one after a fallback). */
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly stop: 'end' | 'max_tokens' | 'refusal' | 'other';
  /** True when the provider re-ran the request on a fallback model after a refusal. */
  readonly fallbackUsed: boolean;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type ErrorKind = 'auth' | 'rate_limit' | 'bad_request' | 'server' | 'network';

/** A failed model call, classified so the UI can say what to do. Never carries the key. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network';
  }
}

export function kindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

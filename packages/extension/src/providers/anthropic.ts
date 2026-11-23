import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type CompletionRequest, type CompletionResult, type ModelProvider } from './types.js';

/** Models that support server-side refusal fallbacks (`fallbacks: "default"`). Haiku 5.5 does not. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/**
 * Claude through the official SDK. In the browser the key is the user's own and goes only to
 * api.anthropic.com, which is why dangerouslyAllowBrowser is set. Thinking is left at the model
 * default (adaptive); depth is set with effort.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    opts: { fetchImpl?: typeof fetch; maxRetries?: number } = {},
  ) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: opts.maxRetries ?? 2, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const fallback = FALLBACK_MODELS.has(this.model);
    let res;
    try {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        req.signal ? { signal: req.signal } : {},
      );
    } catch (e) {
      throw toProviderError(e);
    }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const iterations = (res.usage as { iterations?: { type?: string }[] }).iterations ?? [];
    return {
      text,
      model: res.model,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      stop: res.stop_reason === 'end_turn' || res.stop_reason === 'stop_sequence' ? 'end' : res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason === 'refusal' ? 'refusal' : 'other',
      fallbackUsed: iterations.some((i) => i.type === 'fallback_message'),
    };
  }
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', `Anthropic: the API key was rejected (${e.status})`);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', 'Anthropic: rate limited; try again shortly');
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'Anthropic: could not connect');
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return new ProviderError(status >= 500 ? 'server' : 'bad_request', `Anthropic ${status}: ${String(e.message).slice(0, 200)}`);
  }
  return new ProviderError('network', `Anthropic: ${(e as Error).message}`);
}

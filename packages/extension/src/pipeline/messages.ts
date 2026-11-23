import * as z from 'zod/mini';

/** Start or resume a review. Sent by the side panel; carries keys in memory only, never stored. */
export const StartMessageSchema = z.strictObject({
  type: z.literal('review:start'),
  runId: z.string().check(z.regex(/^[a-z0-9-]{8,64}$/)),
  target: z.union([
    z.strictObject({ kind: z.literal('github'), host: z.string(), owner: z.string(), repo: z.string(), number: z.number() }),
    z.strictObject({ kind: z.literal('gitlab'), host: z.string(), project: z.string(), iid: z.number() }),
  ]),
  apiBase: z.string().check(z.regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/api\/v[34])?$/)),
  hostToken: z.optional(z.string()),
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
  model: z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)),
  apiKey: z.optional(z.string()),
  ollamaUrl: z.optional(z.string().check(z.regex(/^http:\/\/localhost:\d{1,5}$/))),
  prices: z.nullable(z.strictObject({ model: z.string(), inPerM: z.number(), outPerM: z.number() })),
  /** The user turned on meaning-based feedback matching and downloaded the model. */
  semanticFeedback: z.optional(z.boolean()),
});
export type StartMessage = z.infer<typeof StartMessageSchema>;

export interface ActiveRunsReply {
  readonly active: readonly string[];
}

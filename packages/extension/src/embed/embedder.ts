import type { MeaningMatch } from '@repospector/core';

/**
 * Sentence embeddings for meaning-based feedback matching: tokenize, run the model, average the
 * token vectors over the attention mask (mean pooling, as sentence-transformers does for MiniLM),
 * and normalise to unit length so a dot product is the cosine similarity.
 */
export interface TokenizerLike {
  encode(text: string, options: { return_token_type_ids: true }): { ids: number[]; attention_mask: number[]; token_type_ids: number[] };
}

/** The slice of onnxruntime-web used here; the real module is passed in. */
export interface OrtLike {
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown;
}
export interface SessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number>; dims: readonly number[] }>>;
}

/**
 * Same-meaning threshold for MiniLM cosine similarity, from 24 hand-written review-comment pairs
 * (test/embed.test.ts, LIVE_EMBED=1): at 0.55 it caught 7/12 reworded comments and wrongly matched
 * 2/12 comments about a different problem in the same area; word overlap caught 0/12 (and 0/12
 * wrong). A match only counts toward demoting a finding (3+ similar rejections), never hiding it.
 * Small set, hand-written: re-tune when real feedback exists.
 */
export const SAME_MEANING = 0.55;

/** Keeps the first maxTokens-1 tokens and the final [SEP]. */
function truncate<T>(xs: readonly T[], max: number): T[] {
  return xs.length <= max ? [...xs] : [...xs.slice(0, max - 1), xs[xs.length - 1] as T];
}

export function meanPoolNormalize(hidden: ArrayLike<number>, dims: readonly number[], masks: readonly (readonly number[])[]): Float32Array[] {
  const [batch = 0, seq = 0, width = 0] = dims;
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const v = new Float32Array(width);
    let count = 0;
    for (let t = 0; t < seq; t++) {
      if (!masks[b]?.[t]) continue;
      count++;
      const base = (b * seq + t) * width;
      for (let k = 0; k < width; k++) v[k] = (v[k] ?? 0) + (hidden[base + k] ?? 0);
    }
    let norm = 0;
    for (let k = 0; k < width; k++) {
      v[k] = (v[k] ?? 0) / Math.max(count, 1);
      norm += (v[k] ?? 0) ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < width; k++) v[k] = (v[k] ?? 0) / norm;
    out.push(v);
  }
  return out;
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

export function createEmbedder(ort: OrtLike, session: SessionLike, tokenizer: TokenizerLike, maxTokens: number) {
  return async function embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const enc = texts.map((t) => tokenizer.encode(t, { return_token_type_ids: true }));
    const rows = enc.map((e) => ({ ids: truncate(e.ids, maxTokens), mask: truncate(e.attention_mask, maxTokens), types: truncate(e.token_type_ids, maxTokens) }));
    const seq = Math.max(...rows.map((r) => r.ids.length));
    const pad = (xs: readonly number[]) => [...xs, ...Array<number>(seq - xs.length).fill(0)];
    const tensor = (pick: (r: (typeof rows)[number]) => number[]) => new ort.Tensor('int64', BigInt64Array.from(rows.flatMap((r) => pad(pick(r))).map(BigInt)), [rows.length, seq]);
    const output = await session.run({ input_ids: tensor((r) => r.ids), attention_mask: tensor((r) => r.mask), token_type_ids: tensor((r) => r.types) });
    const hidden = output.last_hidden_state;
    if (!hidden) throw new Error('the model returned no last_hidden_state');
    return meanPoolNormalize(hidden.data, hidden.dims, rows.map((r) => pad(r.mask)));
  };
}

/** A MeaningMatch over a fixed set of texts, embedded in batches of 32. */
export async function meaningMatch(texts: readonly string[], embed: (t: readonly string[]) => Promise<Float32Array[]>, threshold = SAME_MEANING): Promise<MeaningMatch> {
  const unique = [...new Set(texts)];
  const vectors = new Map<string, Float32Array>();
  for (let i = 0; i < unique.length; i += 32) {
    const batch = unique.slice(i, i + 32);
    (await embed(batch)).forEach((v, j) => vectors.set(batch[j] ?? '', v));
  }
  return (a, b) => {
    const va = vectors.get(a);
    const vb = vectors.get(b);
    return va !== undefined && vb !== undefined && cosine(va, vb) >= threshold;
  };
}

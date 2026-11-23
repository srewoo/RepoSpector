import { describe, expect, it } from 'vitest';
import { cosine, createEmbedder, meaningMatch, meanPoolNormalize, SAME_MEANING, type OrtLike, type SessionLike, type TokenizerLike } from '../src/embed/embedder.js';
import { downloadModel, MODEL, modelUrl } from '../src/embed/model.js';

describe('meanPoolNormalize', () => {
  it('averages only unmasked token vectors and normalises to unit length', () => {
    // batch 1, 3 tokens, width 2; the third token is padding.
    const [v] = meanPoolNormalize([3, 0, 1, 0, 100, 100], [1, 3, 2], [[1, 1, 0]]);
    expect([...(v ?? [])]).toEqual([1, 0]); // mean (2, 0) -> unit (1, 0); padding ignored
    expect(cosine(v ?? new Float32Array(), v ?? new Float32Array())).toBeCloseTo(1);
  });
});

describe('createEmbedder', () => {
  const tokenizer: TokenizerLike = { encode: (t) => { const ids = [101, ...t.split(' ').map((w) => w.length), 102]; return { ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) }; } };
  const tensors: { data: BigInt64Array; dims: readonly number[] }[] = [];
  const ort: OrtLike = { Tensor: class { constructor(_t: 'int64', data: BigInt64Array, dims: readonly number[]) { tensors.push({ data, dims }); } } as unknown as OrtLike['Tensor'] };
  const session: SessionLike = {
    run: async (feeds) => {
      const ids = tensors.at(-3) ?? { data: new BigInt64Array(), dims: [0, 0] };
      const [b = 0, s = 0] = ids.dims;
      expect(Object.keys(feeds)).toEqual(['input_ids', 'attention_mask', 'token_type_ids']);
      // Each token's vector is (id, 1): the pooled direction depends on the ids.
      const data = new Float32Array(b * s * 2);
      for (let i = 0; i < b * s; i++) (data[i * 2] = Number(ids.data[i])), (data[i * 2 + 1] = 1);
      return { last_hidden_state: { data, dims: [b, s, 2] } };
    },
  };

  it('pads a batch to its longest text, truncates to the limit keeping the final token, and sends int64 tensors', async () => {
    tensors.length = 0;
    const embed = createEmbedder(ort, session, tokenizer, 4);
    const out = await embed(['a bb', 'a bb ccc dddd eeeee']);
    expect(out).toHaveLength(2);
    const ids = tensors[0];
    expect(ids?.dims).toEqual([2, 4]);
    expect([...(ids?.data ?? [])].map(Number)).toEqual([101, 1, 2, 102, 101, 1, 2, 102]); // second row cut to 3 + [SEP]
    const mask = tensors[1];
    expect([...(mask?.data ?? [])].map(Number)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('meaningMatch embeds each distinct text once and compares by threshold', async () => {
    let calls = 0;
    const fake = async (texts: readonly string[]) => (calls++, texts.map((t) => new Float32Array(t.startsWith('x') ? [1, 0] : [0, 1])));
    const match = await meaningMatch(['x1', 'x2', 'y', 'x1'], fake);
    expect(calls).toBe(1);
    expect(match('x1', 'x2')).toBe(true);
    expect(match('x1', 'y')).toBe(false);
    expect(match('x1', 'unknown')).toBe(false);
    expect(SAME_MEANING).toBeGreaterThan(0.5);
  });
});

describe('downloadModel', () => {
  it('fetches the pinned revision and refuses a file whose checksum does not match', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => (urls.push(String(u)), new Response('tampered'))) as typeof fetch;
    await expect(downloadModel(fetchImpl)).rejects.toThrow(/did not match its expected checksum/);
    expect(urls).toEqual([modelUrl('tokenizer.json')]);
    expect(urls[0]).toContain(`/resolve/${MODEL.revision}/`);
  });
});

// Opt-in: LIVE_EMBED=1 downloads the real model (23 MB) from huggingface.co, verifies it, and runs it.
describe.skipIf(!process.env.LIVE_EMBED)('the real model', () => {
  it('scores same-meaning review comments above unrelated ones', async () => {
    const files = await downloadModel(fetch);
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(files['onnx/model_quantized.onnx']);
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as object;
    const embed = createEmbedder(ort as unknown as OrtLike, session as unknown as SessionLike, new Tokenizer(json(files['tokenizer.json']), json(files['tokenizer_config.json'])) as unknown as TokenizerLike, MODEL.maxTokens);
    const [a, b, c, d] = await embed([
      'The variable name tmp is unclear; use a descriptive name.',
      'Rename tmp to something that says what it holds.',
      'Null pointer dereference when user is missing from the session.',
      'Possible crash: session.user can be null here and is dereferenced.',
    ]);
    const same1 = cosine(a!, b!);
    const same2 = cosine(c!, d!);
    const unrelated = cosine(a!, c!);
    console.log(`same meaning: ${same1.toFixed(2)}, ${same2.toFixed(2)}; unrelated: ${unrelated.toFixed(2)}; threshold ${SAME_MEANING}`);
    expect(same1).toBeGreaterThan(unrelated);
    expect(same2).toBeGreaterThan(unrelated);
    expect(unrelated).toBeLessThan(SAME_MEANING);
  }, 180_000);

  it('at the threshold, catches reworded comments and rarely matches a different problem (calibration set)', async () => {
    const files = await downloadModel(fetch);
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(files['onnx/model_quantized.onnx']);
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as object;
    const embed = createEmbedder(ort as unknown as OrtLike, session as unknown as SessionLike, new Tokenizer(json(files['tokenizer.json']), json(files['tokenizer_config.json'])) as unknown as TokenizerLike, MODEL.maxTokens);
    // Same point, different wording.
    const same: [string, string][] = [
  ['The variable name tmp is unclear; use a descriptive name.', 'Rename tmp to something that says what it holds.'],
  ['Null pointer dereference when user is missing from the session.', 'Possible crash: session.user can be null here and is dereferenced.'],
  ['Consider adding a docstring to this function.', 'This method is missing documentation.'],
  ['Magic number 86400 should be a named constant.', 'Extract 86400 into a constant like SECONDS_PER_DAY.'],
  ['This log statement is too verbose for production.', 'Remove or downgrade this debug logging.'],
  ['Unused import of lodash.', 'lodash is imported but never used.'],
  ['The loop reads one element past the end of the array.', 'Off-by-one: i <= items.length overruns the array.'],
  ['Missing await: the promise is not awaited, so errors are lost.', 'This async call is not awaited and its rejection is unhandled.'],
  ['SQL query built by string concatenation allows injection.', 'User input is interpolated into the SQL string: SQL injection risk.'],
  ['Prefer const over let since it is never reassigned.', 'This let can be const.'],
  ['Function is too long; consider splitting it.', 'This method does too much and should be broken up.'],
  ['Typo in comment: recieve should be receive.', 'Spelling mistake "recieve" in the comment.'],
];
    // Same area, different problem.
    const different: [string, string][] = [
  ['The variable name tmp is unclear; use a descriptive name.', 'tmp is reassigned inside the loop, so the total is wrong.'],
  ['Null pointer dereference when user is missing from the session.', 'The session is never invalidated on logout.'],
  ['Consider adding a docstring to this function.', 'This function returns the wrong value for empty input.'],
  ['Magic number 86400 should be a named constant.', 'The timeout of 86400 ms is 86 seconds, not one day.'],
  ['This log statement is too verbose for production.', 'The log line prints the user\'s password.'],
  ['Unused import of lodash.', 'lodash.merge mutates the shared default config.'],
  ['The loop reads one element past the end of the array.', 'The loop skips the first element of the array.'],
  ['Missing await: the promise is not awaited, so errors are lost.', 'Awaiting inside the loop makes the requests sequential and slow.'],
  ['SQL query built by string concatenation allows injection.', 'The SQL query is missing an index on user_id.'],
  ['Prefer const over let since it is never reassigned.', 'The let declaration shadows the outer variable of the same name.'],
  ['Function is too long; consider splitting it.', 'This function is called recursively without a base case.'],
  ['Typo in comment: recieve should be receive.', 'The comment says it retries three times but the code retries once.'],
];
    const match = await meaningMatch([...same.flat(), ...different.flat()], embed);
    const caught = same.filter(([a, b]) => match(a, b)).length;
    const wrong = different.filter(([a, b]) => match(a, b)).length;
    console.log(`threshold ${SAME_MEANING}: caught ${caught}/12 reworded, wrongly matched ${wrong}/12 different`);
    expect(caught).toBeGreaterThanOrEqual(7);
    expect(wrong).toBeLessThanOrEqual(2);
  }, 180_000);
});

import type { MeaningMatch } from '@repospector/core';
import { createEmbedder, meaningMatch, type OrtLike, type SessionLike, type TokenizerLike } from './embedder.js';
import { loadModel, MODEL } from './model.js';

/**
 * Builds the meaning matcher inside the review worker from the model saved on this device. The ONNX
 * runtime and its WebAssembly ship with the extension (ort/); nothing is loaded from elsewhere.
 * Throws when the model is not downloaded; the engine then falls back to word overlap.
 */
export async function loadMeaning(): Promise<(texts: readonly string[]) => Promise<MeaningMatch>> {
  const files = await loadModel();
  if (!files) throw new Error('the model is not downloaded on this device');
  const ort = await import('onnxruntime-web/wasm');
  // Single-threaded: extension workers are not cross-origin isolated, so no SharedArrayBuffer.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // Only the .wasm path: the JS loader is already in this bundle (a folder prefix would make ORT import ort/*.mjs too).
  ort.env.wasm.wasmPaths = { wasm: new URL('ort/ort-wasm-simd-threaded.wasm', self.location.href).href };
  const session = await ort.InferenceSession.create(files['onnx/model_quantized.onnx'], { executionProviders: ['wasm'] });
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const text = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as object;
  const tokenizer = new Tokenizer(text(files['tokenizer.json']), text(files['tokenizer_config.json'])) as unknown as TokenizerLike;
  const embed = createEmbedder(ort as unknown as OrtLike, session as unknown as SessionLike, tokenizer, MODEL.maxTokens);
  return (texts) => meaningMatch(texts, embed);
}

import os from 'node:os';
import path from 'node:path';
import { env, pipeline } from '@xenova/transformers';

/**
 * Local embeddings in Node, satisfying the contract RAGService calls:
 *   init(onProgress), generateEmbeddings(texts, opts), generateEmbedding(text),
 *   getDimension(), getModelInfo()
 *
 * Same package, model and dimensionality as the extension's local path
 * (Xenova/all-MiniLM-L6-v2, 384 dims), so an index built by either side is
 * semantically comparable. Keyless and offline after the first download.
 *
 * The Gemini and OpenAI embedding providers are deliberately not wired up:
 * they need API keys, and offering them would reintroduce the thing this
 * package exists to remove.
 */

export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

export function createNodeEmbedder({ cacheDir } = {}) {
    // Cache under the user's home rather than inside node_modules: `npx`
    // installs to a temporary directory, so a node_modules cache would
    // re-download the model on every invocation.
    env.cacheDir = cacheDir || path.join(os.homedir(), '.repospector', 'models');
    env.allowLocalModels = true;

    let extractor = null;
    let loading = null;

    async function ensure(onProgress) {
        if (extractor) return extractor;
        if (!loading) {
            loading = pipeline('feature-extraction', MODEL_NAME, {
                progress_callback: onProgress || undefined,
            }).then((p) => { extractor = p; loading = null; return p; });
        }
        return loading;
    }

    return {
        async init(onProgress = null) {
            await ensure(onProgress);
            return true;
        },

        getDimension() { return EMBEDDING_DIMENSION; },

        // `name` and `isReady` line this up with OffscreenEmbeddingService's
        // shape ({ name, dimension, isReady, provider }): RAGService.
        // getProviderInfo() spreads whichever embedder is present, and a
        // caller reading `.name` on this adapter would otherwise silently get
        // `undefined`. `model` stays too, so anything already reading it
        // keeps working — this only adds keys, it renames nothing. Matching
        // model and dimension across the two sides was the point of picking
        // the same model in the first place; this makes the metadata agree
        // as well.
        getModelInfo() {
            return {
                provider: 'local',
                model: MODEL_NAME,
                name: MODEL_NAME,
                dimension: EMBEDDING_DIMENSION,
                isReady: extractor !== null,
            };
        },

        /**
         * @param {string[]} texts
         * @returns {Promise<number[][]>} one vector per input, in input order.
         */
        async generateEmbeddings(texts) {
            const list = Array.isArray(texts) ? texts : [texts];
            if (list.length === 0) return [];
            const model = await ensure();
            const out = [];
            // One text at a time: batching here would need padding and a mean
            // over the attention mask, and the retrieval quality gain is not
            // worth a second, subtly different pooling implementation.
            for (const text of list) {
                const t = await model(String(text ?? ''), { pooling: 'mean', normalize: true });
                out.push(Array.from(t.data));
            }
            return out;
        },

        async generateEmbedding(text) {
            const [v] = await this.generateEmbeddings([text]);
            return v;
        },
    };
}

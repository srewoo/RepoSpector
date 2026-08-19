/**
 * GeminiEmbeddingService — repository embeddings via Google's Gemini API.
 *
 * The third embedding provider, alongside bundled Transformers.js (local, free)
 * and OpenAI. It exists because a team already paying for Gemini as their review
 * model had no way to use one vendor for both: picking Gemini for chat still
 * forced an OpenAI key purely to index a repository.
 *
 * Kept as its own service rather than a third branch inside RAGService because
 * the request shape, batch ceiling, and normalisation rule are all specific to
 * this API, and RAGService is already the largest file in the RAG path.
 *
 * ── Two details in this API that quietly break retrieval if ignored ─────────
 *
 * 1. `taskType`. Gemini embeddings are ASYMMETRIC: a document and a query about
 *    that document must be embedded with different task types
 *    (RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY) or similarity is measurably worse.
 *    Neither local nor OpenAI embeddings work this way, so RAGService had no
 *    notion of it and every embedding would have been a "document" — including
 *    search queries.
 *
 * 2. Truncated dimensions are not normalised. `gemini-embedding-001` is a
 *    Matryoshka model: it natively emits 3072 dimensions and any smaller
 *    `outputDimensionality` is a truncation, which Google documents as NOT
 *    unit-normalised (unlike the full 3072 output). See `_normalize`.
 */

/** Batch ceiling for `batchEmbedContents`. Requests above this are rejected. */
const MAX_BATCH = 100;

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Output dimension.
 *
 * 1536 deliberately matches OpenAI's `text-embedding-3-small`, so switching
 * between the two hosted providers keeps the storage footprint and the HNSW
 * tuning in `VectorStore` (which picks `M` from the dimension) in the range this
 * codebase is already exercised at. The model's native 3072 would double index
 * size for a gain nobody here has measured.
 */
export const GEMINI_EMBEDDING_DIMENSION = 1536;

/** Task types this service uses. Gemini's retrieval embeddings are asymmetric. */
export const TASK_TYPE = Object.freeze({
    DOCUMENT: 'RETRIEVAL_DOCUMENT',
    QUERY: 'RETRIEVAL_QUERY',
});

export class GeminiEmbeddingService {
    /**
     * @param {Object} options
     * @param {string} options.apiKey - Google AI Studio key
     * @param {string} [options.model]
     * @param {number} [options.dimension]
     * @param {number} [options.maxRetries=3]
     */
    constructor(options = {}) {
        this.apiKey = options.apiKey;
        this.model = options.model || GEMINI_EMBEDDING_MODEL;
        this.dimension = Number.isFinite(options.dimension)
            ? options.dimension
            : GEMINI_EMBEDDING_DIMENSION;
        this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 3;
    }

    /** Nothing to warm up — the API is stateless. Present so callers can treat
     *  all three embedding services the same way. */
    async init() {
        if (!this.apiKey) {
            throw new Error(
                'Google API key is required for Gemini embeddings. Add it in '
                + 'Settings → AI Configuration, or switch Embedding Provider to Local.',
            );
        }
        return true;
    }

    getModelInfo() {
        return { model: this.model, dimension: this.dimension, provider: 'gemini' };
    }

    /**
     * Embed a list of texts.
     *
     * @param {string[]} texts
     * @param {Object} [options]
     * @param {string} [options.taskType=TASK_TYPE.DOCUMENT] - see class docs; use
     *        TASK_TYPE.QUERY when embedding a search query, never for indexing
     * @returns {Promise<number[][]>} one vector per input, in input order
     */
    async generateEmbeddings(texts, options = {}) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        if (!this.apiKey) {
            throw new Error('Google API key is required for Gemini embeddings');
        }

        const taskType = options.taskType || TASK_TYPE.DOCUMENT;
        const out = [];

        // Chunk to the API ceiling. RAGService already batches at 10 for
        // indexing, but this must hold for any caller.
        for (let i = 0; i < texts.length; i += MAX_BATCH) {
            const slice = texts.slice(i, i + MAX_BATCH);
            const vectors = await this._embedBatchWithRetry(slice, taskType);
            out.push(...vectors);
        }
        return out;
    }

    async _embedBatchWithRetry(texts, taskType) {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await this._embedBatch(texts, taskType);
            } catch (error) {
                lastError = error;
                // An invalid key or a disabled API will never succeed on retry;
                // failing fast keeps the actionable message instead of burying it
                // behind three backoffs.
                if (error?.isAuthError) throw error;

                if (attempt < this.maxRetries) {
                    const delay = 2 ** (attempt - 1) * 500; // 500ms, 1s, 2s
                    console.log(`⏳ Gemini embedding retry ${attempt}/${this.maxRetries} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError;
    }

    async _embedBatch(texts, taskType) {
        const url = `${API_BASE}/models/${this.model}:batchEmbedContents`;
        const body = {
            requests: texts.map(text => ({
                model: `models/${this.model}`,
                content: { parts: [{ text: String(text ?? '') }] },
                taskType,
                outputDimensionality: this.dimension,
            })),
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Header rather than `?key=`: a key in the query string ends up in
                // logs and error traces.
                'x-goog-api-key': this.apiKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const detail = payload?.error?.message || response.statusText;
            const error = new Error(`Gemini Embedding API error (${response.status}): ${detail}`);
            if (response.status === 400 || response.status === 401 || response.status === 403) {
                error.isAuthError = true;
            }
            throw error;
        }

        const data = await response.json();
        const embeddings = data?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
            // A short array would silently misalign vectors with their chunks —
            // every subsequent search would return the wrong file.
            throw new Error(
                `Gemini returned ${embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
            );
        }

        return embeddings.map((e) => {
            const values = e?.values;
            if (!Array.isArray(values) || values.length === 0) {
                throw new Error('Gemini returned an empty embedding');
            }
            return this._normalize(values);
        });
    }

    /**
     * Unit-normalise a truncated embedding.
     *
     * `gemini-embedding-001` emits normalised vectors at its native 3072
     * dimensions only; any smaller `outputDimensionality` is a Matryoshka
     * truncation whose norm is no longer 1, and Google's own guidance is to
     * normalise it before use.
     *
     * Our two cosine implementations in `VectorStore`/`HNSWIndex` divide by both
     * norms, so they are already norm-invariant and this changes no result there
     * today. It matters for what comes after: a stored vector that claims to be
     * comparable to an OpenAI or local one should actually be, and any future
     * dot-product shortcut would otherwise read truncated Gemini vectors as
     * systematically less similar than they are.
     */
    _normalize(values) {
        if (values.length >= 3072) return values; // native output, already unit-norm

        let sumSquares = 0;
        for (const v of values) sumSquares += v * v;
        const norm = Math.sqrt(sumSquares);
        if (!norm || !Number.isFinite(norm)) return values;
        return values.map(v => v / norm);
    }
}

export default GeminiEmbeddingService;

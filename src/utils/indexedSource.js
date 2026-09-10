/**
 * indexedSource — reassemble a file from its indexed chunks WITHOUT losing line
 * numbers. P1-3.
 *
 * The RAG store holds overlapping chunks, each with the line it starts at.
 * Joining their contents gives text whose line numbers drift, which is fine for
 * a prompt and useless for "what does the call at line 42 pass?" — the question
 * the signature rule has to answer before it may assert that a caller broke.
 *
 * So each chunk is placed at its recorded start line and the gaps are left
 * blank. The result is sparse but line-accurate: line N of the output is line N
 * of the file, or empty when that line was never indexed.
 */

/**
 * @param {Array<{content: string, startLine?: number}>} chunks
 * @returns {string|null} null when nothing carries a line number, since a
 *   line-inaccurate reconstruction is worse than none for this purpose.
 */
export function stitchChunksByLine(chunks = []) {
    const usable = (Array.isArray(chunks) ? chunks : [])
        .filter((c) => c && typeof c.content === 'string' && Number.isInteger(c.startLine));
    if (usable.length === 0) return null;

    const lines = [];
    for (const chunk of usable) {
        const body = chunk.content.split('\n');
        for (let i = 0; i < body.length; i++) {
            // 1-based startLine to a 0-based array.
            const index = chunk.startLine - 1 + i;
            if (index < 0) continue;
            // Overlapping chunks agree on the overlap; last write wins either way.
            lines[index] = body[i];
        }
    }
    for (let i = 0; i < lines.length; i++) if (lines[i] === undefined) lines[i] = '';
    return lines.join('\n');
}

/**
 * Read several files out of the RAG vector store as line-accurate text.
 *
 * Never throws: an unavailable index, a missing file or a chunk set with no
 * line numbers all yield "no source", which the caller must treat as "could not
 * check" rather than "nothing wrong".
 *
 * @returns {Promise<Map<string, string>>}
 */
export async function readIndexedSources(vectorStore, repoId, paths = []) {
    const out = new Map();
    if (!vectorStore?.getChunksForFiles || !repoId || !paths.length) return out;

    let map;
    try {
        map = await vectorStore.getChunksForFiles(repoId, paths);
    } catch {
        return out;
    }
    if (!map) return out;

    for (const [path, chunks] of map) {
        const text = stitchChunksByLine(chunks);
        if (text) out.set(path, text);
    }
    return out;
}

export default { stitchChunksByLine, readIndexedSources };

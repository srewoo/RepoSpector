/**
 * Chunk IDs are the only place a chunk's file path is guaranteed to survive.
 *
 * RAGService mints every chunk id as `${repoId}:${filePath}:${chunkIndex}`, and
 * stores the path a second time as a top-level `filePath` field. The keyword
 * half of hybrid search does not carry that field: BM25 is fed `chunk.metadata`,
 * which held only `{tokens, type, language}`, so fused results came back with
 * `filePath: undefined`. Two things broke downstream, both silently:
 *
 *   - `formatRetrievedContext` labelled every snippet `// File: unknown`, so the
 *     model was handed code it could not cite or open.
 *   - `deduplicateResults` buckets by path, so every chunk landed in one
 *     `'unknown'` bucket and `maxChunksPerFile` (4) became a cap on the whole
 *     result set — asking for 10 chunks returned 4, from 4 different files.
 *
 * `metadata.filePath` is populated going forward, but indexes already persisted
 * in users' IndexedDB do not have it. Parsing the id recovers the path for those
 * without forcing a re-index, which is why this fallback exists rather than a
 * migration.
 */

/**
 * Recover a chunk's file path from its id.
 *
 * @param {string} chunkId  `${repoId}:${filePath}:${chunkIndex}`
 * @param {string} [repoId] The repo the chunk belongs to. Supplied, it anchors
 *   the parse: only the exact `${repoId}:` prefix is stripped, so a path that
 *   itself contains a colon still resolves. Omitted, the first segment is
 *   assumed to be the repo id.
 * @returns {string|null} The path, or null if `chunkId` is not a chunk id.
 */
export function filePathFromChunkId(chunkId, repoId) {
    if (typeof chunkId !== 'string' || chunkId === '') return null;

    // The trailing `:<digits>` is the chunk index. Without it this is not an id
    // we minted, and guessing at a path would be worse than reporting nothing.
    const withoutIndex = chunkId.replace(/:\d+$/, '');
    if (withoutIndex === chunkId) return null;

    let rest;
    if (typeof repoId === 'string' && repoId !== '') {
        const prefix = `${repoId}:`;
        if (!withoutIndex.startsWith(prefix)) return null;
        rest = withoutIndex.slice(prefix.length);
    } else {
        const firstColon = withoutIndex.indexOf(':');
        if (firstColon === -1) return null;
        rest = withoutIndex.slice(firstColon + 1);
    }

    return rest === '' ? null : rest;
}

/**
 * The file path for a search result, checked in order of trustworthiness:
 * the field the result carries, then its metadata, then its id.
 *
 * @param {object} result A chunk or search hit.
 * @param {string} [repoId] Anchors the id parse. See `filePathFromChunkId`.
 * @returns {string|null}
 */
export function resolveChunkFilePath(result, repoId) {
    if (!result || typeof result !== 'object') return null;
    return result.filePath
        || result.metadata?.filePath
        || filePathFromChunkId(result.docId || result.id, repoId)
        || null;
}

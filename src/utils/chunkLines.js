/**
 * chunkLines — give every indexed chunk the line number it starts at.
 *
 * Without this, anything that surfaces indexed source has to tell the model
 * "do not cite line numbers from this excerpt", because a chunk is a substring
 * of a file with no record of where. That warning is load-bearing — locations
 * drive `citationEnforcer`, the inline-comment formatter, and the hunk filter,
 * so a wrong line is worse than no line. But it also means the reviewer can
 * read a caller and then not point at it.
 *
 * The chunker already emits a `startIndex`, and it is not trustworthy: it is
 * computed as `lastBoundaryIndex - segment.length` at one push site and
 * `lastBoundaryIndex - currentChunk.length` at another, neither of which
 * accounts for the ~200 tokens of overlap prepended when a new chunk starts.
 * Rather than unpick that arithmetic — it feeds other callers — this locates
 * each chunk in the file directly. The chunk content is a verbatim substring,
 * so an exact search is both simpler and correct by construction.
 *
 * Pure and synchronous; runs once per file at index time.
 */

/**
 * Assign a 1-based `startLine` to each chunk.
 *
 * Chunks are searched in order from a moving cursor, so a file containing the
 * same text twice (a repeated license header, a duplicated block) matches the
 * occurrence that belongs to this chunk rather than the first one in the file.
 *
 * A chunk that cannot be located — content was transformed after chunking, or
 * a custom chunker produced something that is not a substring — gets a null
 * `startLine`, and every consumer treats null as "no line information" and
 * falls back to the old warn-the-model behaviour. Guessing would be worse:
 * a confident wrong line is exactly the failure this exists to prevent.
 *
 * @param {string} fileContent - the full file the chunks came from
 * @param {Array<{content: string}>} chunks - in order
 * @returns {Array<Object>} the same chunks with `startLine` added
 */
export function assignChunkStartLines(fileContent, chunks) {
    const source = String(fileContent ?? '');
    const list = Array.isArray(chunks) ? chunks : [];
    if (!source || list.length === 0) {
        return list.map(c => ({ ...c, startLine: null }));
    }

    // Prefix line counts, so each lookup is a scan of the gap since the last
    // chunk rather than of the whole file — O(file) overall, not O(file × chunks).
    let cursor = 0;
    let lineAtCursor = 1;

    return list.map((chunk) => {
        const content = String(chunk?.content ?? '');
        if (!content) return { ...chunk, startLine: null };

        let at = source.indexOf(content, cursor);
        // Overlap means a chunk can begin slightly BEFORE the previous chunk's
        // end, so a strict forward-only search legitimately misses. Retry from
        // the start before giving up.
        if (at === -1) at = source.indexOf(content);
        if (at === -1) return { ...chunk, startLine: null };

        if (at >= cursor) {
            lineAtCursor += countNewlines(source, cursor, at);
        } else {
            lineAtCursor = 1 + countNewlines(source, 0, at);
        }
        cursor = at;

        return { ...chunk, startLine: lineAtCursor };
    });
}

function countNewlines(text, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) {
        if (text.charCodeAt(i) === 10) n++;
    }
    return n;
}

/**
 * Render source with a line-number gutter, starting at `startLine`.
 *
 * Format matches `formatPatchWithLineNumbers` (`   12 | code`) so the model
 * sees one convention for "here is code with real line numbers" whether it
 * came from the diff or from the index.
 *
 * @param {string} content
 * @param {number|null} startLine
 * @returns {string} numbered source, or the content unchanged when there is no
 *   line information to attach
 */
export function numberLines(content, startLine) {
    if (!Number.isInteger(startLine) || startLine < 1) return String(content ?? '');
    const lines = String(content ?? '').split('\n');
    const width = String(startLine + lines.length - 1).length;
    return lines
        .map((line, i) => `${String(startLine + i).padStart(width, ' ')} | ${line}`)
        .join('\n');
}

export default { assignChunkStartLines, numberLines };

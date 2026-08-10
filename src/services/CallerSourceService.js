/**
 * CallerSourceService — show the reviewer the code that would break, not a
 * count of it.
 *
 * The code graph already resolves, exactly, which functions call a symbol the
 * diff changed. Until now the review prompt received that as prose:
 *
 *     **Called by** (3):
 *     - `handleUpload` (src/api/upload.js) [92%]
 *
 * That is enough for the model to say "this has callers, check them" and not
 * enough for it to say anything true about whether they break. The caller's
 * argument list, its null handling, whether it already guards the case the diff
 * changed — none of it is visible. So the finding that matters most for a
 * signature change ("`handleUpload` passes two arguments, this now takes
 * three") is one the reviewer structurally cannot produce.
 *
 * This module fetches the callers' actual source out of the local index and
 * inlines it.
 *
 * ── Why chunks, and where the line numbers come from ──
 *
 * The indexer overlaps consecutive chunks by ~200 tokens, so a file
 * reconstructed by concatenating them repeats lines and any line number derived
 * from it is wrong. A confidently wrong location is worse than none here —
 * `citationEnforcer` and the hunk filter treat locations as load-bearing. So we
 * ship the ONE chunk containing the caller rather than a stitched file.
 *
 * Each chunk records the line it starts at (see `chunkLines.js`), so the
 * excerpt can carry real numbers. Indexes built before that existed have no
 * start line; those excerpts render unnumbered and say so, rather than
 * inventing a number.
 *
 * Everything here is local (IndexedDB) and fail-soft: no network, and any
 * failure yields no caller sources rather than a failed review.
 */

import { numberLines } from '../utils/chunkLines.js';

/** Hard ceiling on inlined callers per review, whatever the per-symbol budget. */
const MAX_TOTAL_CALLERS = 12;

/**
 * Build a regex that finds where `name` is declared, across the languages the
 * indexer covers. Used to pick WHICH chunk of a file to show — a file's third
 * chunk is the right one only if that is where the caller actually lives.
 */
function declarationPattern(name) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `(?:function\\s+${n}\\b)`
        + `|(?:\\b(?:const|let|var)\\s+${n}\\s*=)`
        + `|(?:\\b(?:class|interface|type|enum)\\s+${n}\\b)`
        + `|(?:\\bdef\\s+${n}\\b)`
        + `|(?:\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${n}\\b)`
        + `|(?:\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\())`
        + `|(?:\\b${n}\\s*\\([^)]*\\)\\s*\\{)`,
        'm',
    );
}

/**
 * Pick the chunk of a file most likely to contain a symbol, and the line index
 * within it where the symbol appears.
 *
 * @param {Array<{chunkIndex: number, content: string, startLine?: number}>} chunks
 * @param {string} name
 * @returns {{content: string, lineIndex: number, startLine: number|null}|null}
 */
export function locateInChunks(chunks, name) {
    if (!Array.isArray(chunks) || chunks.length === 0) return null;

    const decl = declarationPattern(name);
    // Prefer a declaration; fall back to any mention; else the first chunk, so
    // the model at least sees the file rather than nothing.
    for (const pass of [decl, new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)]) {
        for (const chunk of chunks) {
            const m = pass.exec(chunk.content);
            if (!m) continue;
            const lineIndex = chunk.content.slice(0, m.index).split('\n').length - 1;
            return { content: chunk.content, lineIndex, startLine: chunk.startLine ?? null };
        }
    }
    return { content: chunks[0].content, lineIndex: 0, startLine: chunks[0].startLine ?? null };
}

/**
 * Take a window of lines around `lineIndex`, biased to show the body that
 * follows a declaration rather than centring on it — what breaks a caller is
 * usually how it USES the changed symbol, which is below the signature.
 *
 * @param {string} content
 * @param {number} lineIndex
 * @param {number} maxLines
 * @returns {{text: string, offset: number}} `offset` is the window's first line
 *   index within the chunk, so an absolute line number can be recovered.
 */
export function windowAround(content, lineIndex, maxLines) {
    const lines = String(content || '').split('\n');
    if (lines.length <= maxLines) return { text: lines.join('\n'), offset: 0 };

    const before = Math.min(4, Math.floor(maxLines / 4));
    const start = Math.max(0, lineIndex - before);
    const end = Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, end);

    if (end < lines.length) slice.push('// … truncated');
    // `offset` is how far into the chunk the window begins, so a caller holding
    // the chunk's own start line can compute the window's absolute first line.
    return { text: slice.join('\n'), offset: start };
}

export class CallerSourceService {
    /**
     * @param {Object} deps
     * @param {Object} deps.codeGraphPipeline
     * @param {Object} deps.vectorStore - needs `getChunksForFiles(repoId, paths)`
     */
    constructor({ codeGraphPipeline, vectorStore } = {}) {
        this.pipeline = codeGraphPipeline;
        this.vectorStore = vectorStore;
    }

    /**
     * Resolve caller source for a set of changed symbols.
     *
     * Loads every needed file in ONE index pass rather than one per caller —
     * the store is indexed by repo, so a per-file read rescans the whole repo.
     *
     * @param {string[]} symbols - symbols the diff declares or modifies
     * @param {string} repoId
     * @param {Object} [opts]
     * @param {number} [opts.perSymbol=3] - callers inlined per symbol
     * @param {number} [opts.maxLines=40] - source lines per caller
     * @param {Set<string>} [opts.excludeFiles] - paths already in the diff
     * @returns {Promise<{bySymbol: Record<string, string>, stats: Object}>}
     */
    async build(symbols, repoId, opts = {}) {
        const { perSymbol = 3, maxLines = 40, excludeFiles = new Set() } = opts;
        const empty = { bySymbol: {}, stats: { symbols: 0, callers: 0, filesLoaded: 0 } };

        if (!this.pipeline || !this.vectorStore || !repoId) return empty;
        if (!Array.isArray(symbols) || symbols.length === 0 || perSymbol <= 0) return empty;

        try {
            // 1. Resolve refs from the graph (synchronous, in-memory).
            const refsBySymbol = new Map();
            const paths = new Set();
            let total = 0;

            for (const symbol of symbols) {
                if (total >= MAX_TOTAL_CALLERS) break;
                const refs = (this.pipeline.getCallerRefs?.(symbol, perSymbol * 2) || [])
                    // A caller inside the diff is already in front of the model;
                    // spending budget on it displaces one that isn't.
                    .filter(r => !excludeFiles.has(r.filePath))
                    .slice(0, Math.min(perSymbol, MAX_TOTAL_CALLERS - total));
                if (refs.length === 0) continue;
                refsBySymbol.set(symbol, refs);
                refs.forEach(r => paths.add(r.filePath));
                total += refs.length;
            }

            if (refsBySymbol.size === 0) return empty;

            // 2. One index pass for every file any caller lives in.
            const chunksByFile = await this.vectorStore.getChunksForFiles(repoId, [...paths]);
            if (!chunksByFile || chunksByFile.size === 0) return empty;

            // 3. Render.
            const bySymbol = {};
            let rendered = 0;
            for (const [symbol, refs] of refsBySymbol) {
                const blocks = [];
                for (const ref of refs) {
                    const chunks = chunksByFile.get(ref.filePath);
                    if (!chunks?.length) continue;
                    const located = locateInChunks(chunks, ref.name);
                    if (!located) continue;
                    const win = windowAround(located.content, located.lineIndex, maxLines);
                    if (!win.text.trim()) continue;

                    // Real line numbers when the index recorded where the chunk
                    // starts; otherwise the excerpt stays unnumbered and the
                    // header warns the model off citing lines. Indexes built
                    // before line tracking existed take the second path, so an
                    // existing install degrades rather than citing wrong lines.
                    const absoluteStart = Number.isInteger(located.startLine)
                        ? located.startLine + win.offset
                        : null;
                    const body = absoluteStart ? numberLines(win.text, absoluteStart) : win.text;

                    const confidence = Math.round((ref.confidence || 0) * 100);
                    const where = absoluteStart
                        ? `lines ${absoluteStart}+, real line numbers shown`
                        : 'line numbers unavailable — do not cite them';
                    blocks.push(
                        `#### Caller: \`${ref.name}\` in ${ref.filePath}`
                        + ` (call resolved with ${confidence}% confidence; ${where})\n`
                        + '```\n' + body + '\n```',
                    );
                    rendered++;
                }
                if (blocks.length) bySymbol[symbol] = blocks.join('\n\n');
            }

            return {
                bySymbol,
                stats: {
                    symbols: Object.keys(bySymbol).length,
                    callers: rendered,
                    filesLoaded: chunksByFile.size,
                },
            };
        } catch (e) {
            console.warn('CallerSourceService: build failed (non-fatal):', e?.message);
            return empty;
        }
    }
}

export default CallerSourceService;

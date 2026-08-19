/**
 * hunks — slice a single file's patch into hunks.
 *
 * Corpus cases store `prData.files[].patch` and no pre-parsed hunks, so
 * adjudication has to find the window around a finding's line itself.
 *
 * This does not use `src/utils/diffParser.js`: that class consumes a whole
 * multi-file diff, which is the wrong input granularity, and pulling a
 * thousand-line parser in to find `@@` boundaries in one patch would be the
 * more complex option rather than the simpler one. The header regex is
 * deliberately the same shape it uses.
 */

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * @param {string} patch
 * @returns {Array<{header:string, text:string, newStart:number, newEnd:number, oldStart:number, lines:string[]}>}
 */
export function splitHunks(patch) {
    if (!patch || typeof patch !== 'string') return [];

    const hunks = [];
    let current = null;

    for (const line of patch.split('\n')) {
        const match = line.match(HUNK_HEADER);
        if (match) {
            if (current) hunks.push(current);
            const oldStart = Number(match[1]);
            const newStart = Number(match[3]);
            // An omitted count means 1 — `@@ -5 +5 @@` is a single-line hunk.
            const newCount = match[4] === undefined ? 1 : Number(match[4]);
            current = {
                header: line,
                lines: [],
                oldStart,
                newStart,
                // A zero-length hunk (pure deletion) must not report an end
                // before its start, or no line can ever fall inside it.
                newEnd: newStart + Math.max(newCount, 1) - 1,
            };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) hunks.push(current);

    return hunks.map(h => ({ ...h, text: [h.header, ...h.lines].join('\n') }));
}

/**
 * The hunk covering `line` on the new side, or null.
 *
 * Null is the honest answer for a finding whose line is outside every hunk —
 * showing an arbitrary neighbouring hunk would invite a verdict on code the
 * finding was not about.
 *
 * @param {string} patch
 * @param {number|null|undefined} line
 */
export function hunkForLine(patch, line) {
    if (line == null || Number.isNaN(Number(line))) return null;
    const n = Number(line);
    // Line numbers are 1-based. Reject 0 and negatives on principle rather
    // than by accident — `Number(null)` and `Number('')` both coerce to 0,
    // and without this guard a bogus 0 would be "rejected" only because no
    // hunk happens to start at line 0, not because the code says so.
    if (n <= 0) return null;
    return splitHunks(patch).find(h => n >= h.newStart && n <= h.newEnd) ?? null;
}

export default { splitHunks, hunkForLine };

/**
 * patchLines — the single shared primitive for turning a unified-diff patch
 * into line information.
 *
 * Several call sites need "which lines does this patch touch?": the orchestrator
 * (assigned-hunk normalization), the inline-comment formatter (a review comment
 * posted on a line outside the diff is rejected by the host), and incremental
 * re-review (which files/lines are new since the last reviewed commit).
 *
 * They must agree. Keeping one implementation here avoids the class of bug where
 * two parsers drift and findings survive one filter but not the other.
 */

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse a unified-diff patch into hunks with per-line new/old numbering.
 *
 * @param {string} patch
 * @returns {Array<{newStart:number, newLines:number, oldStart:number, lines:Array<{type:string, number:{new:number|null, old:number|null}, content:string}>}>}
 */
export function parsePatchHunks(patch) {
    if (!patch || typeof patch !== 'string') return [];

    const hunks = [];
    let cur = null;
    let newCursor = 0;
    let oldCursor = 0;

    for (const line of patch.split('\n')) {
        const m = line.match(HUNK_HEADER_RE);
        if (m) {
            if (cur) hunks.push(cur);
            const oldStart = parseInt(m[1], 10);
            const newStart = parseInt(m[3], 10);
            cur = {
                oldStart,
                newStart,
                newLines: parseInt(m[4] || '1', 10),
                lines: [],
            };
            newCursor = newStart;
            oldCursor = oldStart;
            continue;
        }
        if (!cur) continue;

        // "\ No newline at end of file" is metadata, not a line of either side.
        if (line.startsWith('\\')) continue;

        if (line.startsWith('+') && !line.startsWith('+++')) {
            cur.lines.push({ type: 'added', number: { new: newCursor, old: null }, content: line.slice(1) });
            newCursor++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            cur.lines.push({ type: 'deleted', number: { new: null, old: oldCursor }, content: line.slice(1) });
            oldCursor++;
        } else if (line.startsWith(' ') || line === '') {
            cur.lines.push({ type: 'context', number: { new: newCursor, old: oldCursor }, content: line.slice(1) });
            newCursor++;
            oldCursor++;
        }
    }
    if (cur) hunks.push(cur);
    return hunks;
}

/** New-side line numbers of ADDED lines only. */
export function addedLines(patch) {
    const out = new Set();
    for (const h of parsePatchHunks(patch)) {
        for (const l of h.lines) {
            if (l.type === 'added' && l.number.new != null) out.add(l.number.new);
        }
    }
    return out;
}

/**
 * New-side line numbers a review comment may legally target.
 *
 * Both GitHub and GitLab accept a comment on any line that appears in the diff
 * on the new side — added AND context lines. Posting outside this set is a hard
 * API error (GitHub 422s the ENTIRE review, not just the offending comment), so
 * this set is what the formatter validates against.
 */
export function commentableLines(patch) {
    const out = new Set();
    for (const h of parsePatchHunks(patch)) {
        for (const l of h.lines) {
            if ((l.type === 'added' || l.type === 'context') && l.number.new != null) {
                out.add(l.number.new);
            }
        }
    }
    return out;
}

/**
 * Map of `filename -> Set<commentable new-side line>` for a normalized PR's files.
 * @param {Array<{filename?:string, new_path?:string, path?:string, patch?:string, diff?:string}>} files
 * @returns {Map<string, Set<number>>}
 */
export function buildCommentableLineMap(files = []) {
    const map = new Map();
    for (const f of files || []) {
        const name = f?.filename || f?.new_path || f?.path;
        if (!name) continue;
        map.set(name, commentableLines(f.patch ?? f.diff ?? ''));
    }
    return map;
}

/**
 * Nearest legal line to `line` within `allowed`, or null when the file has no
 * commentable lines at all. Lets a finding whose line is slightly off (a very
 * common LLM failure mode — off-by-one, or pointing at the function header
 * instead of the body) still land as an inline comment instead of being dropped.
 *
 * @param {number} line
 * @param {Set<number>} allowed
 * @param {number} maxDistance - refuse to snap further than this many lines
 * @returns {number|null}
 */
export function snapToCommentableLine(line, allowed, maxDistance = 5) {
    if (!allowed || allowed.size === 0) return null;
    if (allowed.has(line)) return line;

    let best = null;
    let bestDist = Infinity;
    for (const candidate of allowed) {
        const dist = Math.abs(candidate - line);
        if (dist < bestDist || (dist === bestDist && candidate < best)) {
            best = candidate;
            bestDist = dist;
        }
    }
    return bestDist <= maxDistance ? best : null;
}

export default {
    parsePatchHunks,
    addedLines,
    commentableLines,
    buildCommentableLineMap,
    snapToCommentableLine,
};

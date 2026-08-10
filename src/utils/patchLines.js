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
        } else if (line.startsWith(' ')) {
            cur.lines.push({ type: 'context', number: { new: newCursor, old: oldCursor }, content: line.slice(1) });
            newCursor++;
            oldCursor++;
        }
        // An EMPTY string is not a line of the diff. In a unified diff even a blank
        // context line is " " (a single space), so the only way to see '' here is the
        // trailing element `split('\n')` produces for a patch ending in a newline —
        // which GitLab's `diff` field always does.
        //
        // Counting it as context invented a phantom line at lastLine+1, and every
        // consumer trusted it: `commentableLines` offered a line the host has no
        // knowledge of, so a finding there passed validation and GitHub 422'd the
        // ENTIRE review (losing every inline comment, not just the bad one);
        // `snapToCommentableLine` could relocate a good finding onto it; and
        // `oldLineForNewLine` handed GitLab an `old_line` for a line that does not
        // exist, which it rejects with a 400.
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
 * The added ("+") lines of a patch as a standalone code block, together with the
 * real new-side file line number of each.
 *
 * Static analyzers are handed the added lines concatenated, because linting a
 * hunk's context and removed lines would report defects the PR did not
 * introduce. The cost is that every line number an analyzer reports is an index
 * into THAT block, not into the file. `lineNumbers[i]` is the file line for
 * block line `i + 1`, which is what makes the two reconcilable.
 *
 * Both halves come from one parse on purpose: when the block and the map were
 * built by separate scanners with subtly different "is this an added line?"
 * tests, they drifted, and a drifted map is worse than none — it relocates
 * findings silently instead of dropping them.
 *
 * @param {string} patch
 * @returns {{code: string, lineNumbers: number[]}}
 */
export function extractAddedLines(patch) {
    const contents = [];
    const lineNumbers = [];
    for (const h of parsePatchHunks(patch)) {
        for (const l of h.lines) {
            if (l.type === 'added' && l.number.new != null) {
                contents.push(l.content);
                lineNumbers.push(l.number.new);
            }
        }
    }
    return { code: contents.join('\n'), lineNumbers };
}

/**
 * Translate a 1-based line number reported against `extractAddedLines().code`
 * back to the real new-side file line.
 *
 * Returns null when the index is out of range — a finding pointing past the end
 * of the block is not locatable, and inventing a line for it would put a comment
 * on unrelated code.
 *
 * @param {number} blockLine - 1-based line within the added-lines block
 * @param {number[]} lineNumbers - from `extractAddedLines`
 * @returns {number|null}
 */
export function mapAddedBlockLine(blockLine, lineNumbers) {
    const n = Number(blockLine);
    if (!Number.isFinite(n) || n < 1) return null;
    if (!Array.isArray(lineNumbers) || lineNumbers.length === 0) return null;
    return lineNumbers[n - 1] ?? null;
}

/**
 * Old-side (pre-change) line number for a new-side line, when the line exists on
 * both sides — i.e. it is a context line.
 *
 * GitLab rejects a diff note on an unchanged line unless it carries `old_line`
 * as well as `new_line`; added lines must carry only `new_line`. Returning null
 * for an added line is therefore the signal to omit the field, not an error.
 *
 * @param {string} patch
 * @param {number} newLine
 * @returns {number|null}
 */
export function oldLineForNewLine(patch, newLine) {
    const target = Number(newLine);
    if (!Number.isFinite(target)) return null;
    for (const h of parsePatchHunks(patch)) {
        for (const l of h.lines) {
            if (l.type === 'context' && l.number.new === target) return l.number.old;
        }
    }
    return null;
}

/** Width of the line-number gutter — enough for a 999999-line file. */
const GUTTER = 6;

/**
 * Render a patch with ABSOLUTE file line numbers, in pr-agent's hunk format.
 *
 * A raw ```diff block asks the model to do arithmetic: it must count lines from
 * the `@@` header to work out that a defect is on line 887. Models are bad at
 * this, and the failure is silent — the finding is right and the location is
 * wrong, which is worse than no finding, because a comment on the wrong line
 * still reads as authoritative. It is also why the inline formatter needs a ±5
 * snap window to recover the near-misses.
 *
 * Printing the number next to the line removes the arithmetic entirely.
 *
 * Added and removed lines are split into `__new hunk__` / `__old hunk__`
 * sections. Only the new side carries numbers, because only the new side is
 * addressable by a review comment; showing removed lines separately still lets
 * the model see what the change replaced (and notice when a finding is about
 * something the PR deleted).
 *
 * @param {string} patch - unified diff for one file
 * @param {string} [filename] - rendered as a header when given
 * @returns {string}
 */
export function formatPatchWithLineNumbers(patch, filename) {
    const hunks = parsePatchHunks(patch);
    const header = filename ? `## File: '${filename}'\n` : '';
    if (hunks.length === 0) return header ? `${header}(no diff available)\n` : '';

    const out = [header];

    for (const hunk of hunks) {
        const newSide = [];
        const oldSide = [];

        for (const l of hunk.lines) {
            if (l.type === 'added') {
                newSide.push(`${String(l.number.new).padStart(GUTTER)} +${l.content}`);
            } else if (l.type === 'context') {
                newSide.push(`${String(l.number.new).padStart(GUTTER)}  ${l.content}`);
                oldSide.push(`${' '.repeat(GUTTER)}  ${l.content}`);
            } else if (l.type === 'deleted') {
                oldSide.push(`${' '.repeat(GUTTER)} -${l.content}`);
            }
        }

        if (newSide.length) out.push('__new hunk__', newSide.join('\n'));
        // Omit an old hunk that is only unchanged context — it adds tokens and
        // says nothing the new side did not already say.
        if (oldSide.some(l => l.includes(' -'))) out.push('__old hunk__', oldSide.join('\n'));
    }

    return `${out.filter(Boolean).join('\n')}\n`;
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
        // Ties break toward the LOWER line, so the result does not depend on Set
        // iteration order. The guard was `candidate < best` with `best` still null
        // on the first tie — `n < null` is always false — which made an equidistant
        // pair resolve to whichever the Set happened to yield first.
        if (dist < bestDist || (dist === bestDist && best != null && candidate < best)) {
            best = candidate;
            bestDist = dist;
        }
    }
    return bestDist <= maxDistance ? best : null;
}

export default {
    parsePatchHunks,
    addedLines,
    formatPatchWithLineNumbers,
    extractAddedLines,
    mapAddedBlockLine,
    oldLineForNewLine,
    commentableLines,
    buildCommentableLineMap,
    snapToCommentableLine,
};

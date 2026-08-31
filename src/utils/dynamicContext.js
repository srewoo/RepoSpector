/**
 * dynamicContext — grow each hunk out to its enclosing declaration.
 *
 * A unified diff gives the model three lines of context on each side of a
 * change, chosen by git for humans scrolling a patch, not by anything to do with
 * the code's structure. Three lines is routinely the wrong amount: it cuts a
 * function's guard clauses off the top of a change to its body, and it pads a
 * one-line config edit with noise.
 *
 * pr-agent's `allow_dynamic_context` fixes this by searching outward from each
 * hunk to a LOGICAL boundary — the enclosing function or class — instead of a
 * fixed line count, asymmetrically (more before than after, because the code
 * preceding a change is what explains it). This is that idea, with the
 * boundaries taken from `SymbolExtractor`'s real declaration ranges rather than
 * a heuristic backward scan: RepoSpector already computes exact start/end lines
 * per declaration for the knowledge graph, so the enclosing component is a
 * lookup, not a guess.
 *
 * ── Why this matters more here than there ──
 *
 * `reviewContextBudget.js` records the eval finding that misses concentrate in
 * LARGE files, and reads it as attention dilution rather than a rule gap — which
 * is why it warns that raising the global context budgets could make results
 * worse. `HunkWindower` answered that by splitting large diffs. This answers the
 * other half: for a large file, `ReviewFileContextService` currently pastes the
 * ENTIRE post-change file into the prompt. Rendering the hunks expanded to their
 * enclosing declarations gives the model the same structural context at a
 * fraction of the tokens, and without the haystack. See `shouldPreferExpansion`.
 *
 * ── Two invariants, both load-bearing ──
 *
 * 1. The expanded patch is for READING ONLY. Inline-comment validation
 *    (`patchLines.commentableLines`) must keep using the ORIGINAL patch: the
 *    host rejects a comment on a line outside its own diff, and GitHub 422s the
 *    entire review when one comment is invalid, losing all of them. Expansion
 *    therefore never replaces `file.patch`; it produces a separate string used
 *    only when rendering the prompt.
 *
 * 2. Expansion is refused unless the supplied file content VERIFIABLY matches
 *    the patch (see `verifyAlignment`). `fullContent` can be truncated to fit a
 *    byte cap, or fetched at the wrong ref — GitLab defaults to the target
 *    branch, which is the code before the MR. Prepending lines from the wrong
 *    file version would hand the model fabricated context that it has no way to
 *    identify as wrong, which is far worse than three lines of git default.
 */

import { parsePatchHunks } from './patchLines.js';

export const DYNAMIC_CONTEXT_DEFAULTS = Object.freeze({
    enabled: true,
    /** Extra lines before a hunk when no enclosing declaration is found. */
    extraLinesBefore: 3,
    /** Extra lines after. Lower than `before` on purpose — see module header. */
    extraLinesAfter: 1,
    /** Ceiling when expanding to an enclosing declaration's start. */
    maxExtraLinesBefore: 12,
    /** Ceiling when expanding to its end. */
    maxExtraLinesAfter: 6,
    /**
     * Two hunks whose expanded ranges come within this many lines are merged
     * into one, with the gap rendered as context. Without merging, expansion
     * emits the same lines twice in two adjacent hunks.
     */
    mergeGap: 6,
    /**
     * Prose and data files: expanding them buys nothing and costs tokens. Same
     * intent as pr-agent's `patch_extension_skip_types`, extended to the
     * generated/data formats that dominate real diffs.
     */
    skipTypes: Object.freeze([
        '.md', '.txt', '.rst', '.adoc', '.csv', '.tsv', '.json', '.lock',
        '.svg', '.snap', '.po', '.pot',
    ]),
});

/** Line count above which expanded hunks beat pasting the whole file. */
export const LARGE_FILE_LINES = 400;

/**
 * Would expanded hunks serve this file better than its full content?
 *
 * Small files: no. The whole file is a few hundred tokens and strictly more
 * informative than any window of it.
 *
 * Large files: yes — this is the case the eval harness flagged. A 2,000-line
 * file pasted whole is mostly irrelevant to a 12-line change, and the
 * irrelevant part is what dilutes attention.
 *
 * @param {string} fileContent
 * @param {number} [threshold=LARGE_FILE_LINES]
 * @returns {boolean}
 */
export function shouldPreferExpansion(fileContent, threshold = LARGE_FILE_LINES) {
    if (!fileContent || typeof fileContent !== 'string') return false;
    return countLines(fileContent) > threshold;
}

function countLines(text) {
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
    return n;
}

/**
 * Is this path worth expanding at all?
 * @param {string} filename
 * @param {string[]} [skipTypes]
 */
export function isExpandable(filename, skipTypes = DYNAMIC_CONTEXT_DEFAULTS.skipTypes) {
    if (!filename || typeof filename !== 'string') return false;
    const lower = filename.toLowerCase();
    return !skipTypes.some(ext => lower.endsWith(ext));
}

/**
 * Innermost declaration containing `line`.
 *
 * Innermost, not outermost: a method inside a 600-line class should expand to
 * the method. Expanding to the class would reintroduce the whole-file problem
 * this module exists to avoid.
 *
 * @param {Array<{startLine:number, endLine:number, name?:string, label?:string}>} declarations
 * @param {number} line - 1-based new-side line
 * @returns {Object|null}
 */
export function enclosingDeclaration(declarations, line) {
    if (!Array.isArray(declarations) || !Number.isFinite(line)) return null;

    let best = null;
    for (const d of declarations) {
        const start = Number(d?.startLine);
        const end = Number(d?.endLine);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start > line || end < line) continue;
        if (!best || (end - start) < (best.endLine - best.startLine)) {
            best = { ...d, startLine: start, endLine: end };
        }
    }
    return best;
}

/**
 * Does `fileLines` actually correspond to this patch's new side?
 *
 * Checks every context and added line the patch claims, against the same line
 * number in the file. Whitespace-insensitive, because providers differ on
 * trailing whitespace and line endings and a CRLF mismatch is not a wrong file.
 *
 * A single real mismatch fails the whole file: partial alignment means the
 * content is from another ref, and the lines that happen to match are luck.
 *
 * @param {Array<Object>} hunks - from parsePatchHunks
 * @param {string[]} fileLines
 * @returns {{aligned:boolean, checked:number, reason?:string}}
 */
export function verifyAlignment(hunks, fileLines) {
    let checked = 0;

    for (const hunk of hunks) {
        for (const l of hunk.lines) {
            if (l.type === 'deleted' || l.number.new == null) continue;
            const actual = fileLines[l.number.new - 1];
            // Beyond EOF: the content is truncated (maxBytesPerFile) or stale.
            if (actual === undefined) {
                return { aligned: false, checked, reason: 'content ends before the patch does' };
            }
            if (actual.trimEnd() !== l.content.trimEnd()) {
                return {
                    aligned: false,
                    checked,
                    reason: `line ${l.number.new} differs from the patch`,
                };
            }
            checked++;
        }
    }

    // A patch with nothing to check (pure deletions) cannot be verified, so it
    // cannot be safely expanded either.
    if (checked === 0) return { aligned: false, checked, reason: 'no verifiable lines' };
    return { aligned: true, checked };
}

/**
 * Target range for one hunk, after expansion.
 * @returns {{start:number, end:number, boundedBy:string}}
 */
function targetRange(hunk, declarations, opts, fileLineCount) {
    const newNumbers = hunk.lines
        .map(l => l.number.new)
        .filter(n => n != null);

    // A pure-deletion hunk has no new-side lines; anchor on the hunk's declared
    // new-side start so it still expands sensibly.
    const firstNew = newNumbers.length ? newNumbers[0] : hunk.newStart;
    const lastNew = newNumbers.length ? newNumbers[newNumbers.length - 1] : hunk.newStart;

    let start = Math.max(1, firstNew - opts.extraLinesBefore);
    let end = Math.min(fileLineCount, lastNew + opts.extraLinesAfter);
    let boundedBy = 'fixed';

    const decl = enclosingDeclaration(declarations, firstNew)
        || enclosingDeclaration(declarations, lastNew);

    if (decl) {
        const declStart = Math.max(1, decl.startLine);
        const declEnd = Math.min(fileLineCount, decl.endLine);

        // The declaration is BOTH the target and the boundary.
        //
        // Target: expand out to the signature, so the model sees the parameters
        // and guard clauses the change depends on.
        //
        // Boundary: and no further. The fixed window can reach past a
        // declaration's start on its own (a change on the second line of a
        // function is within `extraLinesBefore` of the previous function's
        // closing brace), which spends tokens on an unrelated component's tail
        // and blurs where the reviewed unit begins. Clamping only ever affects
        // context this module ADDED — the hunk's own lines are emitted whatever
        // the range says.
        //
        // The ceilings still win over the target, so a change inside a
        // 2,000-line function does not pull in the function.
        start = Math.max(declStart, firstNew - opts.maxExtraLinesBefore);
        end = Math.min(declEnd, lastNew + opts.maxExtraLinesAfter);
        boundedBy = 'declaration';
    }

    return { start, end, boundedBy };
}

/**
 * Build the line records for one expanded hunk.
 *
 * Records carry their own new/old numbers, so the emitted `@@` header is derived
 * from the records rather than recomputed by arithmetic — which is what keeps a
 * merged hunk's header honest.
 */
function expandHunkRecords(hunk, range, fileLines) {
    const records = [];

    const firstNew = hunk.lines.find(l => l.number.new != null)?.number.new ?? hunk.newStart;
    const firstOld = hunk.lines.find(l => l.number.old != null)?.number.old ?? hunk.oldStart;

    // Leading context. A context line exists on both sides, so both numbers walk
    // backward together.
    for (let n = range.start; n < firstNew; n++) {
        const content = fileLines[n - 1];
        if (content === undefined) continue;
        records.push({
            type: 'context',
            content,
            new: n,
            old: firstOld - (firstNew - n),
        });
    }

    for (const l of hunk.lines) {
        records.push({ type: l.type, content: l.content, new: l.number.new, old: l.number.old });
    }

    // Trailing context continues from the last numbered line of each side.
    const lastNew = [...hunk.lines].reverse().find(l => l.number.new != null)?.number.new ?? (firstNew - 1);
    let oldCursor = [...hunk.lines].reverse().find(l => l.number.old != null)?.number.old ?? (firstOld - 1);

    for (let n = lastNew + 1; n <= range.end; n++) {
        const content = fileLines[n - 1];
        if (content === undefined) break;
        oldCursor++;
        records.push({ type: 'context', content, new: n, old: oldCursor });
    }

    return records;
}

/** Render records as a unified-diff hunk, header derived from the records. */
function emitHunk(records, heading) {
    const newNums = records.filter(r => r.new != null).map(r => r.new);
    const oldNums = records.filter(r => r.old != null).map(r => r.old);

    const newStart = newNums.length ? newNums[0] : 0;
    const oldStart = oldNums.length ? oldNums[0] : 0;

    const header = `@@ -${oldStart},${oldNums.length} +${newStart},${newNums.length} @@`
        + (heading ? heading : '');

    const body = records.map(r => {
        const prefix = r.type === 'added' ? '+' : r.type === 'deleted' ? '-' : ' ';
        return `${prefix}${r.content}`;
    });

    return [header, ...body].join('\n');
}

/**
 * Expand a patch's hunks to their enclosing declarations.
 *
 * Fail-soft in every direction: a missing file, unalignable content, a skipped
 * file type or a thrown parse all return the ORIGINAL patch with
 * `expanded: false`. The caller renders whatever comes back and never has to
 * branch on failure.
 *
 * @param {Object} args
 * @param {string} args.patch - unified diff for one file
 * @param {string} args.filename
 * @param {string} [args.fileContent] - POST-change file content (new side)
 * @param {Array<Object>} [args.declarations] - {startLine, endLine} ranges
 * @param {Object} [args.options] - overrides for DYNAMIC_CONTEXT_DEFAULTS
 * @returns {{patch:string, expanded:boolean, reason?:string, stats:Object}}
 */
export function expandPatch({ patch, filename, fileContent, declarations = [], options = {} } = {}) {
    const opts = { ...DYNAMIC_CONTEXT_DEFAULTS, ...(options || {}) };
    const stats = {
        hunksBefore: 0, hunksAfter: 0, linesAdded: 0,
        boundedByDeclaration: 0, merged: 0,
    };

    const bail = (reason) => ({ patch: patch || '', expanded: false, reason, stats });

    if (!opts.enabled) return bail('disabled');
    if (!patch || typeof patch !== 'string') return bail('no patch');
    if (!isExpandable(filename, opts.skipTypes)) return bail('skipped file type');
    if (!fileContent || typeof fileContent !== 'string') return bail('no file content');

    let hunks;
    try {
        hunks = parsePatchHunks(patch);
    } catch (e) {
        return bail(`unparseable patch: ${e?.message}`);
    }
    if (!hunks.length) return bail('no hunks');

    const fileLines = fileContent.split('\n');
    const alignment = verifyAlignment(hunks, fileLines);
    if (!alignment.aligned) return bail(`content does not match patch: ${alignment.reason}`);

    stats.hunksBefore = hunks.length;

    // Ranges first, then merge, then emit. Merging ranges rather than rendered
    // text is what keeps the gap between two hunks from being emitted twice.
    const ranges = hunks.map(h => targetRange(h, declarations, opts, fileLines.length));
    for (const r of ranges) if (r.boundedBy === 'declaration') stats.boundedByDeclaration++;

    const groups = [];
    for (let i = 0; i < hunks.length; i++) {
        const prev = groups[groups.length - 1];
        const gap = prev ? ranges[i].start - prev.range.end - 1 : Infinity;
        if (prev && gap <= opts.mergeGap) {
            prev.hunks.push(hunks[i]);
            prev.range = { start: prev.range.start, end: Math.max(prev.range.end, ranges[i].end) };
            stats.merged++;
        } else {
            groups.push({ hunks: [hunks[i]], range: { ...ranges[i] } });
        }
    }

    const out = [];
    let originalLines = 0;
    let expandedLines = 0;
    for (const h of hunks) originalLines += h.lines.length;

    for (const group of groups) {
        // A merged group is rebuilt as one record list: expand the first hunk to
        // the group's start, bridge each gap with context, then append the rest.
        const records = expandHunkRecords(
            group.hunks[0],
            { start: group.range.start, end: lastNewOf(group.hunks[0]) },
            fileLines,
        );

        for (let i = 1; i < group.hunks.length; i++) {
            const bridgeFrom = (records[records.length - 1]?.new ?? 0) + 1;
            const nextFirstNew = firstNewOf(group.hunks[i]);
            let oldCursor = records[records.length - 1]?.old ?? 0;
            for (let n = bridgeFrom; n < nextFirstNew; n++) {
                const content = fileLines[n - 1];
                if (content === undefined) break;
                oldCursor++;
                records.push({ type: 'context', content, new: n, old: oldCursor });
            }
            for (const l of group.hunks[i].lines) {
                records.push({ type: l.type, content: l.content, new: l.number.new, old: l.number.old });
            }
        }

        // Trailing context for the group as a whole.
        const lastNew = records[records.length - 1]?.new ?? 0;
        let lastOld = records[records.length - 1]?.old ?? 0;
        for (let n = lastNew + 1; n <= group.range.end; n++) {
            const content = fileLines[n - 1];
            if (content === undefined) break;
            lastOld++;
            records.push({ type: 'context', content, new: n, old: lastOld });
        }

        expandedLines += records.length;
        out.push(emitHunk(records, group.hunks[0].heading));
    }

    stats.hunksAfter = groups.length;
    stats.linesAdded = Math.max(0, expandedLines - originalLines);

    if (stats.linesAdded === 0) return bail('nothing to add');

    return { patch: `${out.join('\n')}\n`, expanded: true, stats };
}

function firstNewOf(hunk) {
    return hunk.lines.find(l => l.number.new != null)?.number.new ?? hunk.newStart;
}

function lastNewOf(hunk) {
    return [...hunk.lines].reverse().find(l => l.number.new != null)?.number.new ?? hunk.newStart;
}

export default {
    expandPatch,
    isExpandable,
    enclosingDeclaration,
    verifyAlignment,
    shouldPreferExpansion,
    DYNAMIC_CONTEXT_DEFAULTS,
};

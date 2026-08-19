/**
 * HunkWindower — split one large file's diff into reviewable windows.
 *
 * `FileGroupingStrategy` already gives a large or high-risk file a SOLO review
 * unit, but nothing split the file itself, so a 900-line diff entered a single
 * prompt whole. The eval harness found misses concentrating in exactly those
 * files — react `store.js`, prometheus `head_wal.go`, kubernetes
 * `scheduling_queue.go` — while the same defect classes were caught 100% of the
 * time in small files, and read the pattern as attention dilution rather than a
 * rule gap. This is the response to that reading.
 *
 * Three rules shape the output:
 *
 *   1. A window never splits an individual hunk. Half a hunk is a diff nobody
 *      can reason about, model or human.
 *   2. A window prefers not to split an enclosing DECLARATION either. Rule 1
 *      alone still permits a break between two hunks that both edit the same
 *      function, which hands each half to a different reviewer and loses any
 *      defect that only shows when both halves are read together. See
 *      `groupIntoSections` for how the boundary is found.
 *   3. Every window says it is one of several. Without that, the obvious
 *      failure mode is the model reporting "the rest of this file is missing"
 *      as a finding.
 *
 * `prData.files[]` carries `patch` and no pre-parsed hunks, so the patch text
 * is the input.
 */

/**
 * Trailing group captures the hunk's section heading — the enclosing
 * declaration git names after the closing `@@` (`@@ -1,4 +1,6 @@ func Serve(`).
 * That heading is the scope signal rule 2 groups on; see `groupIntoSections`.
 */
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

export const WINDOW_DEFAULTS = Object.freeze({
    /** Below this many changed lines, the file is not split at all. */
    minLocToSplit: 250,
    /** Target lines per window. A single larger hunk still gets its own window. */
    maxLocPerWindow: 200,
    /**
     * Trailing lines of the previous window repeated as leading context.
     * Costs a little duplication to avoid a defect falling exactly on a seam;
     * the resulting duplicate findings are removed by the existing per-line
     * dedupe on the way to being posted.
     */
    overlapLines: 20,
    /**
     * Ceiling on how much a single declaration may drag into one window before
     * scope grouping gives up on it.
     *
     * Rule 2 keeps a declaration's hunks together, which necessarily lets a
     * window run past `maxLocPerWindow`. That is the trade we want for a normal
     * function, but a 2,000-line generated `switch` or a whole-file rewrite
     * carries one heading across the entire patch, and honouring rule 2 there
     * would rebuild the single oversized prompt that windowing exists to
     * prevent. Above this size the section is packed hunk-by-hunk instead —
     * attention dilution beats no windowing at all.
     */
    maxSectionLoc: 400,
});

/**
 * Count of changed lines in a patch, used only as a fallback when a file's
 * `additions`/`deletions` metadata is absent or zero. Both platform paths
 * populate that metadata today (GitHub from the API, GitLab by counting `+`
 * lines), so this fallback is not normally reached — but if it were ever
 * missing, treating the file as 0 changed lines would silently disable
 * splitting for a possibly-huge patch, which is the worst failure mode for a
 * feature whose whole point is to split huge patches.
 */
function patchLineCount(patch) {
    if (!patch) return 0;
    return patch.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
}

/** Split a patch into hunk blocks, each starting with its `@@` header. */
function splitIntoHunks(patch) {
    if (!patch || typeof patch !== 'string') return [];
    const hunks = [];
    let current = null;
    for (const line of patch.split('\n')) {
        const m = HUNK_HEADER.exec(line);
        if (m) {
            if (current) hunks.push(current);
            current = { header: line, section: (m[5] || '').trim(), lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) hunks.push(current);
    return hunks.map(h => ({ ...h, loc: h.lines.length + 1, text: [h.header, ...h.lines].join('\n') }));
}

/**
 * Group consecutive hunks that edit the same declaration into one indivisible
 * packing unit.
 *
 * The scope signal is the section heading git already writes into every hunk
 * header (`@@ -10,5 +10,7 @@ func handleRequest(`). Using it rather than a real
 * parse is deliberate: it costs nothing, it is available synchronously here,
 * and it covers every language git has a funcname pattern for. The alternative
 * — asking `TreeSitterParser` — parses in the offscreen document, so it is
 * async and unavailable to a pure function, and it would only recover scope
 * information that git has already handed us in the same string.
 *
 * Only ADJACENT hunks merge. Two distant hunks that happen to share a heading
 * are separate runs, which is the correct reading: git repeats the nearest
 * preceding declaration, so a repeat after an intervening declaration means a
 * different region of the file.
 *
 * A hunk with no heading is its own unit. That keeps behaviour identical to
 * pre-scope-awareness packing for every patch git gave no funcname for — plain
 * text, config, top-of-file edits — instead of collapsing all of them into one
 * giant "" section.
 *
 * @param {Array} hunks - from `splitIntoHunks`
 * @param {number} maxSectionLoc - see WINDOW_DEFAULTS.maxSectionLoc
 * @returns {Array<Array>} packing units, each a non-empty array of hunks
 */
function groupIntoSections(hunks, maxSectionLoc) {
    const runs = [];
    for (const hunk of hunks) {
        const prev = runs[runs.length - 1];
        const sameDeclaration =
            prev &&
            hunk.section &&
            prev[prev.length - 1].section === hunk.section;
        if (sameDeclaration) prev.push(hunk);
        else runs.push([hunk]);
    }

    // A run too large to keep whole degrades to individual hunks rather than
    // dominating a window. Rule 1 still holds for each of them.
    const units = [];
    for (const run of runs) {
        const loc = run.reduce((sum, h) => sum + h.loc, 0);
        if (run.length > 1 && loc > maxSectionLoc) units.push(...run.map(h => [h]));
        else units.push(run);
    }
    return units;
}

function noteFor(index, total) {
    if (total <= 1) return '';
    return `This is window ${index} of ${total} of the changes to this file. ` +
        `The other windows are being reviewed separately — code you cannot see here is ` +
        `not missing, so do not report it as absent or incomplete. Do not create a finding ` +
        `whose subject is missing, truncated, or incomplete code in this file.`;
}

/**
 * Split one file's diff into windows.
 *
 * Always returns at least one window, so callers need no below-threshold
 * special case.
 *
 * @param {{filename:string, patch?:string, additions?:number, deletions?:number}} file
 * @param {Partial<typeof WINDOW_DEFAULTS>} [opts]
 * @returns {Array<{filename:string, patch:string, windowIndex:number, windowTotal:number,
 *                  additions:number, deletions:number, siblingNote:string}>}
 */
export function windowFile(file, opts = {}) {
    const o = { ...WINDOW_DEFAULTS, ...opts };
    const patch = typeof file?.patch === 'string' ? file.patch : '';
    // Prefer the file's own metadata; only fall back to counting the patch
    // when it is absent or zero, so a file missing that metadata does not
    // get silently treated as tiny and skip splitting altogether. The
    // `hunks.length <= 1` guard below still forces a single window for a
    // genuinely trivial patch, so this fallback cannot cause spurious splits.
    const metaChanged = (file?.additions ?? 0) + (file?.deletions ?? 0);
    const changed = metaChanged > 0 ? metaChanged : patchLineCount(patch);

    const single = () => ([{
        filename: file?.filename,
        patch,
        windowIndex: 1,
        windowTotal: 1,
        additions: file?.additions ?? 0,
        deletions: file?.deletions ?? 0,
        siblingNote: '',
    }]);

    if (!patch || changed < o.minLocToSplit) return single();

    const hunks = splitIntoHunks(patch);
    if (hunks.length <= 1) return single();

    // Pack into windows, never breaking a unit. A unit that alone exceeds the
    // target starts and ends its own window rather than being cut — for a
    // single hunk that is rule 1, for a multi-hunk section it is rule 2.
    const units = groupIntoSections(hunks, o.maxSectionLoc);
    const groups = [];
    let group = [];
    let groupLoc = 0;
    for (const unit of units) {
        const unitLoc = unit.reduce((sum, h) => sum + h.loc, 0);
        if (group.length && groupLoc + unitLoc > o.maxLocPerWindow) {
            groups.push(group);
            group = [];
            groupLoc = 0;
        }
        group.push(...unit);
        groupLoc += unitLoc;
    }
    if (group.length) groups.push(group);

    if (groups.length <= 1) return single();

    return groups.map((groupHunks, i) => {
        const body = groupHunks.map(h => h.text).join('\n');
        // Overlap is rendered as a leading comment block, not as diff lines:
        // appending real diff lines would corrupt the hunk line accounting the
        // reviewer uses to attribute a finding to a line number. It leads the
        // window (as genuinely-preceding context) rather than trailing it, so
        // the model reads the overlapped lines in their true chronological
        // position before the window's own new code, not after it. "Never
        // splits a hunk" is still upheld: this block is never itself a hunk,
        // and the window's first real hunk header follows it intact.
        let overlap = '';
        if (i > 0 && o.overlapLines > 0) {
            const prev = groups[i - 1].map(h => h.text).join('\n').split('\n');
            const tail = prev.slice(-o.overlapLines);
            if (tail.some(l => l.trim())) {
                // Every line of the block — including the copied tail — is
                // comment-prefixed, so nothing in it can be mistaken for a
                // real diff line (e.g. a `+`-prefixed addition) by a
                // downstream line-number scanner.
                const commented = tail.map(l => `# ${l}`).join('\n');
                overlap = `# Preceding context from the previous window (already reviewed there):\n${commented}\n\n`;
            }
        }
        return {
            filename: file.filename,
            patch: `${overlap}${body}`,
            windowIndex: i + 1,
            windowTotal: groups.length,
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            siblingNote: noteFor(i + 1, groups.length),
        };
    });
}

export default { windowFile, WINDOW_DEFAULTS };

/**
 * todoScanner — surface TODO/FIXME markers this PR ADDS.
 *
 * Deliberately not a finding. A TODO is not a defect: it is a note the author
 * left on purpose, and routing it through the findings pipeline would put it
 * through severity gating, adversarial verification, and the inline cap — three
 * mechanisms designed to decide whether a defect claim is true, applied to
 * something making no claim at all. It would also displace a real finding under
 * the inline cap, which is the worst possible trade.
 *
 * So this is a deterministic scan rendered as its own informational section,
 * like PR-Agent's `todo_sections`, except PR-Agent spends model tokens asking
 * for it. Nothing here needs a model: a regex over added lines is exact, free,
 * and cannot hallucinate a TODO that is not there.
 *
 * Only ADDED lines are scanned. A pre-existing TODO in a file this PR happens to
 * touch is not news, and reporting it would make every edit to an old file look
 * like it introduced debt.
 */

/**
 * Markers worth surfacing, and how they are ranked when the cap bites.
 *
 * FIXME and HACK outrank TODO because they assert something is currently wrong
 * rather than merely unfinished. XXX is included because it is conventional, and
 * excluded from the "needs a ticket" nudge because it is too often a scratch
 * marker rather than a commitment.
 */
const MARKERS = Object.freeze([
    { keyword: 'FIXME', rank: 0 },
    { keyword: 'HACK', rank: 1 },
    { keyword: 'XXX', rank: 2 },
    { keyword: 'TODO', rank: 3 },
]);

/**
 * A marker must sit inside a comment, not in a string literal or identifier.
 *
 * Without the comment-leader requirement this matches `const TODO_STATES = [...]`
 * and every user-facing string containing the word "todo" — which in a codebase
 * with a task feature is a lot of them. Covers `//`, `#`, `/* *\/`, `<!-- -->`,
 * `--`, `%`, and `*` continuation lines in block comments.
 */
const COMMENT_LEADER = /(?:\/\/+|#+|\/\*+|\*|<!--|--|%|;+)\s*/;

/** Built per call rather than module-level: `lastIndex` on a shared regex bites. */
function markerPattern() {
    const keywords = MARKERS.map(m => m.keyword).join('|');
    // Optional `(owner)` / `[JIRA-123]` and an optional colon, then the note.
    return new RegExp(
        `${COMMENT_LEADER.source}(${keywords})\\b[\\s]*(?:[([][^)\\]]*[)\\]])?\\s*:?\\s*(.*)$`,
        'i',
    );
}

/** Words that suggest the TODO is tracked, so the nudge is unnecessary. */
const TRACKED = /\b([A-Z][A-Z0-9]+-\d+|#\d+|issue\s*\d+|gh-\d+)\b/i;

export const TODO_DEFAULTS = Object.freeze({
    /** Ceiling on reported markers, so a vendored dump cannot flood the comment. */
    maxItems: 20,
    /** Characters of the note text kept. */
    maxNoteChars: 160,
});

/**
 * Scan a PR's diff for markers introduced by it.
 *
 * @param {Object} prData - needs `files[].filename` and `files[].patch`
 * @param {Partial<typeof TODO_DEFAULTS>} [opts]
 * @returns {{items: Array<{file:string, line:number|null, keyword:string, note:string, tracked:boolean}>,
 *            total:number}}
 *          `total` is the true count; `items` is capped.
 */
export function scanAddedTodos(prData, opts = {}) {
    const o = { ...TODO_DEFAULTS, ...opts };
    const pattern = markerPattern();
    const rankOf = new Map(MARKERS.map(m => [m.keyword.toUpperCase(), m.rank]));
    const items = [];

    for (const file of prData?.files || []) {
        if (!file?.patch || !file?.filename) continue;

        // Track the new-file line number across hunks so a marker can be cited
        // at a real location rather than a diff offset.
        let newLine = 0;
        for (const raw of String(file.patch).split('\n')) {
            const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
            if (hunk) {
                newLine = Number.parseInt(hunk[1], 10);
                continue;
            }
            if (raw.startsWith('---') || raw.startsWith('+++')) continue;

            const isAdded = raw.startsWith('+');
            const isContext = raw.startsWith(' ') || raw === '';
            // Removed lines do not advance the new-file counter.
            if (!isAdded && !isContext) continue;

            const content = raw.slice(1);
            if (isAdded) {
                const m = pattern.exec(content);
                if (m) {
                    const keyword = m[1].toUpperCase();
                    const note = String(m[2] ?? '').trim().slice(0, o.maxNoteChars);
                    items.push({
                        file: file.filename,
                        line: newLine || null,
                        keyword,
                        note,
                        tracked: TRACKED.test(content),
                        _rank: rankOf.get(keyword) ?? 99,
                    });
                }
            }
            newLine++;
        }
    }

    // Severity-ish order first, then file, so the cap keeps the ones that assert
    // something is wrong over the ones that merely note unfinished work.
    items.sort((a, b) => a._rank - b._rank || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

    return {
        items: items.slice(0, o.maxItems).map(({ _rank, ...rest }) => rest),
        total: items.length,
    };
}

/**
 * Render the markers as a summary section.
 *
 * Returns '' when there is nothing, so callers concatenate unconditionally.
 *
 * @param {ReturnType<typeof scanAddedTodos>} scan
 */
export function renderTodoSection(scan) {
    const items = scan?.items || [];
    if (!items.length) return '';

    const untracked = items.filter(i => !i.tracked && i.keyword !== 'XXX').length;

    const out = ['', '### Markers added by this PR', ''];
    for (const item of items) {
        const loc = `\`${item.file}${item.line != null ? `:${item.line}` : ''}\``;
        const note = item.note ? ` — ${item.note}` : '';
        out.push(`- **${item.keyword}** ${loc}${note}`);
    }
    if (scan.total > items.length) {
        out.push(`- _…and ${scan.total - items.length} more._`);
    }
    if (untracked) {
        out.push('', `_${untracked} of these reference no ticket._`);
    }
    return out.join('\n');
}

export default { scanAddedTodos, renderTodoSection, TODO_DEFAULTS };

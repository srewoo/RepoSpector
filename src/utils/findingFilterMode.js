/**
 * findingFilterMode — one named, testable answer to "which lines may a finding
 * be reported on?"
 *
 * RepoSpector already filters findings to the diff, in three places that each
 * knew part of the rule:
 *
 *   FindingsNormalizer   drops findings outside the assigned hunks, snapping
 *                        near-misses within `snapWindow`
 *   patchLines           `commentableLines` = added AND context lines
 *   inlineCommentFormatter `snapToCommentableLine(line, allowed, 5)`
 *
 * Stack those and the actual promise is "added, or context, or within five lines
 * of either". That is materially weaker than what any reviewer assumes when a bot
 * comments on their line, and it was nowhere stated.
 *
 * reviewdog states it, as `-filter-mode`. Naming the policy is itself the
 * credibility feature: "we only report on lines your PR added" is a claim you can
 * publish and a test can hold you to. The four modes here are reviewdog's, with
 * the same names, so a team that knows reviewdog needs no new vocabulary.
 *
 * ── Relocation is reported, never silent ──
 *
 * The near-miss snap is genuinely useful: models are off by one, and dropping a
 * correct finding because it named the function header instead of the body is a
 * bad trade. But moving a comment onto a line the model did not choose and saying
 * nothing is a small dishonesty that compounds — the reviewer reads a precise
 * line number that nobody actually asserted.
 *
 * So a relocated finding carries `relocated: {from, to, distance}` and the
 * renderer can say so. This is herdr-reviewr's "stale, not silently dropped"
 * principle applied where RepoSpector actually has drift.
 */

import { parsePatchHunks } from './patchLines.js';
import { classifyRemovedLines } from './deletionSignificance.js';

export const FILTER_MODE = Object.freeze({
    /** Only lines this PR ADDED. The strictest, and the default. */
    ADDED: 'added',
    /** Added lines plus their surrounding diff context. */
    DIFF_CONTEXT: 'diff_context',
    /** Anywhere in a file the PR changed. */
    FILE: 'file',
    /** No scoping at all. */
    NOFILTER: 'nofilter',
});

export const FILTER_MODE_DEFAULT = FILTER_MODE.ADDED;

/**
 * How far a near-miss may be moved, per mode.
 *
 * `added` gets a small window rather than zero: the off-by-one failure is real
 * and a two-line move is still inside the changed region. Anything larger stops
 * being a correction and starts being a guess about where the defect is.
 */
const SNAP_WINDOW = Object.freeze({
    [FILTER_MODE.ADDED]: 2,
    [FILTER_MODE.DIFF_CONTEXT]: 5,
    [FILTER_MODE.FILE]: 0,
    [FILTER_MODE.NOFILTER]: 0,
});

/** Human-readable statement of the policy, for the review output. */
export const FILTER_MODE_DESCRIPTION = Object.freeze({
    [FILTER_MODE.ADDED]: 'lines this PR added',
    [FILTER_MODE.DIFF_CONTEXT]: 'lines this PR added, and the diff context around them',
    [FILTER_MODE.FILE]: 'anywhere in the files this PR changed',
    [FILTER_MODE.NOFILTER]: 'anywhere (no diff filtering)',
});

/**
 * Coerce a configured value into a mode.
 *
 * An unrecognised value falls back to the DEFAULT rather than to `nofilter`: a
 * typo must not silently widen the scope to the whole repository, which would
 * bury the reviewer in findings about code they did not touch.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFilterMode(value) {
    if (typeof value !== 'string') return FILTER_MODE_DEFAULT;
    const v = value.trim().toLowerCase().replace(/-/g, '_');
    return Object.values(FILTER_MODE).includes(v) ? v : FILTER_MODE_DEFAULT;
}

/**
 * The set of new-side lines a finding may target, for one file.
 *
 * @param {string} patch
 * @param {string} mode
 * @returns {{lines:Set<number>|null, fileLevel:boolean}} `lines: null` means
 *          "any line" (file / nofilter modes)
 */
export function allowedLines(patch, mode = FILTER_MODE_DEFAULT) {
    const m = normalizeFilterMode(mode);

    if (m === FILTER_MODE.FILE || m === FILTER_MODE.NOFILTER) {
        return { lines: null, fileLevel: true };
    }

    const out = new Set();
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) {
            if (l.number.new == null) continue;
            if (l.type === 'added') out.add(l.number.new);
            else if (l.type === 'context' && m === FILTER_MODE.DIFF_CONTEXT) out.add(l.number.new);
        }
    }
    return { lines: out, fileLevel: false };
}

/**
 * Old-side line ranges this patch REMOVED, and whether each removal is
 * behaviourally significant (see utils/deletionSignificance.js).
 *
 * P1-1: `added` mode scopes findings to new-side lines, which is right for a
 * finding about added code and fatal for a finding about deleted code — the
 * removed lines have no new-side number at all, so a correct "you deleted the
 * authorization check" was dropped as "outside the diff". This gives the filter
 * the vocabulary to recognise one.
 *
 * @param {string} patch
 * @returns {{ranges: Array<{from:number, to:number, significant:boolean}>}}
 */
export function removedRanges(patch) {
    const ranges = [];
    for (const hunk of parsePatchHunks(patch)) {
        let run = null;
        const flush = () => {
            if (!run) return;
            const { significant } = classifyRemovedLines(run.texts);
            ranges.push({ from: run.from, to: run.to, significant });
            run = null;
        };
        for (const l of hunk.lines) {
            if ((l.type === 'deleted' || l.type === 'removed') && l.number.old != null) {
                if (!run) run = { from: l.number.old, to: l.number.old, texts: [] };
                run.to = l.number.old;
                run.texts.push(l.content ?? l.text ?? '');
            } else {
                flush();
            }
        }
        flush();
    }
    return { ranges };
}

/** Does this finding claim to be about code the change REMOVED? */
function claimsRemoval(finding) {
    return finding?.removal === true
        || finding?.onDeletedLine === true
        || String(finding?.side ?? '').toLowerCase() === 'old'
        || finding?.oldLine != null;
}

/**
 * Apply the filter to a set of findings.
 *
 * Returns kept and dropped findings separately, with a reason on each drop.
 * Nothing disappears silently: `stats` is what the review reports so that
 * "the review said nothing about my change" is always traceable to a decision.
 *
 * @param {Array<Object>} findings - each with {filePath|file, line}
 * @param {Array<{filename:string, patch?:string}>} files - the PR's changed files
 * @param {Object} [opts]
 * @param {string} [opts.mode]
 * @param {boolean} [opts.allowFileLevel=true] - keep line-less findings for a changed file
 * @returns {{kept:Array, dropped:Array, stats:Object}}
 */
export function applyFilterMode(findings = [], files = [], { mode = FILTER_MODE_DEFAULT, allowFileLevel = true } = {}) {
    const m = normalizeFilterMode(mode);
    const kept = [];
    const dropped = [];
    const stats = {
        mode: m,
        in: findings.length,
        kept: 0,
        relocated: 0,
        droppedOutsideDiff: 0,
        droppedUnknownFile: 0,
        droppedNoLine: 0,
        // A deletion finding kept as a file-level statement rather than dropped.
        // The host cannot place an inline comment on a line that no longer
        // exists, but that is a COMMENT PLACEMENT limit, not a reason to discard
        // a proven defect (P1-1).
        keptAsRemovalSummary: 0,
    };

    if (m === FILTER_MODE.NOFILTER) {
        stats.kept = findings.length;
        return { kept: [...findings], dropped, stats };
    }

    // One parse per file, not per finding: a 60-file PR with 200 findings would
    // otherwise re-parse the same patches hundreds of times.
    const byFile = new Map();
    for (const f of files) {
        const name = f?.filename || f?.new_path || f?.path;
        if (!name) continue;
        const patch = f.patch ?? f.diff ?? '';
        byFile.set(name, { ...allowedLines(patch, m), removed: removedRanges(patch).ranges });
    }

    const window = SNAP_WINDOW[m] ?? 0;

    for (const finding of findings) {
        const path = finding.filePath || finding.file || null;

        if (!path || !byFile.has(path)) {
            stats.droppedUnknownFile++;
            dropped.push({ ...finding, filteredBecause: 'file is not part of this PR' });
            continue;
        }

        const { lines, fileLevel, removed } = byFile.get(path);
        // `Number(null)` is 0 and `Number('')` is 0, both finite — so coercing
        // first turns a line-less finding into a finding on line 0, which then
        // fails every scope check and is dropped as "outside the diff". Reject the
        // empty forms before touching Number().
        const rawLine = finding.line;
        const line = (rawLine === null || rawLine === undefined || rawLine === '' || !Number.isFinite(Number(rawLine)))
            ? null
            : Number(rawLine);

        // An explicit removal claim is handled before the line checks: it may
        // arrive with `oldLine` and no `line` at all, and falling through to the
        // file-level branch would keep it without the removal anchor the
        // renderer needs to say WHERE the deleted code was.
        if (claimsRemoval(finding)) {
            const anchorLine = finding.oldLine ?? line;
            const range = coversRemoval(removed, anchorLine);
            kept.push({
                ...finding,
                line: null,
                removal: true,
                removedAnchor: {
                    side: 'old',
                    line: anchorLine ?? null,
                    ...(range ? { from: range.from, to: range.to } : {}),
                },
            });
            stats.kept++;
            stats.keptAsRemovalSummary++;
            continue;
        }

        // A finding with no line is a statement about the file. Legitimate for a
        // changed file ("this file's new dependency is vulnerable"), and there is
        // nothing to scope it to.
        if (line === null) {
            if (allowFileLevel) {
                kept.push(finding);
                stats.kept++;
            } else {
                stats.droppedNoLine++;
                dropped.push({ ...finding, filteredBecause: 'no line, and file-level findings are disabled' });
            }
            continue;
        }

        if (fileLevel || lines.has(line)) {
            kept.push(finding);
            stats.kept++;
            continue;
        }

        // A finding whose line falls inside a SIGNIFICANT removal, checked
        // before the near-miss snap: snapping would relocate a claim about
        // deleted code onto a surviving added line, which reads as an assertion
        // about the wrong thing. Significance is required here because this is
        // an inference — without it, any new-side finding whose line number
        // happens to collide with a removed old line would be rescued.
        const range = coversRemoval(removed, line);
        if (range?.significant) {
            kept.push({
                ...finding,
                line: null,
                removal: true,
                removedAnchor: { side: 'old', line, from: range.from, to: range.to },
            });
            stats.kept++;
            stats.keptAsRemovalSummary++;
            continue;
        }

        // Near-miss: move it, and say that it moved.
        const snapped = nearest(line, lines, window);
        if (snapped !== null) {
            kept.push({
                ...finding,
                line: snapped,
                relocated: { from: line, to: snapped, distance: Math.abs(snapped - line) },
            });
            stats.kept++;
            stats.relocated++;
            continue;
        }

        stats.droppedOutsideDiff++;
        dropped.push({
            ...finding,
            filteredBecause: `line ${line} is outside ${FILTER_MODE_DESCRIPTION[m]}`,
        });
    }

    return { kept, dropped, stats };
}

/** The removed range covering `line`, or null. */
function coversRemoval(ranges, line) {
    if (!Array.isArray(ranges) || line == null) return null;
    return ranges.find((r) => line >= r.from && line <= r.to) ?? null;
}

/**
 * Nearest allowed line within `window`.
 *
 * Ties break toward the LOWER line so the result does not depend on Set
 * iteration order — the same bug `snapToCommentableLine` documents.
 */
function nearest(line, allowed, window) {
    if (!allowed || allowed.size === 0 || window <= 0) return null;

    let best = null;
    let bestDist = Infinity;
    for (const candidate of allowed) {
        const dist = Math.abs(candidate - line);
        if (dist < bestDist || (dist === bestDist && best !== null && candidate < best)) {
            best = candidate;
            bestDist = dist;
        }
    }
    return bestDist <= window ? best : null;
}

/**
 * One line for the review output, stating the policy that was applied.
 *
 * Always rendered, even when nothing was dropped. The value is in the review
 * saying what it looked at — a reviewer who knows the scope can tell the
 * difference between "clean" and "out of scope", which is the difference between
 * trusting the tool and being surprised by it later.
 */
export function describeFilterMode(stats) {
    if (!stats) return '';
    const parts = [`Findings scoped to ${FILTER_MODE_DESCRIPTION[stats.mode]}`];

    const outside = stats.droppedOutsideDiff + stats.droppedUnknownFile;
    if (outside) parts.push(`${outside} finding(s) outside that scope were not reported`);
    if (stats.relocated) {
        parts.push(`${stats.relocated} finding(s) were moved to the nearest reportable line`);
    }
    if (stats.keptAsRemovalSummary) {
        parts.push(
            `${stats.keptAsRemovalSummary} finding(s) about REMOVED code are reported at file `
            + 'level, because the host cannot place an inline comment on a deleted line'
        );
    }
    return `${parts.join('; ')}.`;
}

/** `(moved from line 41)` for a relocated finding, or '' — for comment bodies. */
export function relocationNote(finding) {
    const r = finding?.relocated;
    if (!r) return '';
    return ` _(reported on line ${r.from}; moved ${r.distance} line(s) to the nearest line in the diff)_`;
}

export default {
    FILTER_MODE,
    FILTER_MODE_DEFAULT,
    normalizeFilterMode,
    allowedLines,
    applyFilterMode,
    describeFilterMode,
    relocationNote,
};

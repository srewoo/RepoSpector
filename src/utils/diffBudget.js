/**
 * diffBudget — spend the prompt's diff allowance on the parts of it worth money.
 *
 * Three separate leaks, all taken from pr-agent's `pr_processing.py`, none of
 * which RepoSpector guarded against:
 *
 * 1. DELETION-ONLY HUNKS. A hunk that only removes lines has nothing to review:
 *    the prompt already tells the model never to report a finding against a
 *    removed line, so those tokens buy a rule saying to ignore them. On a
 *    refactor or a file move they are most of the diff.
 *    → `stripDeletionOnlyHunks` (pr-agent's `handle_patch_deletions`).
 *
 * 2. NO OUTPUT RESERVE. The context window was treated as available for input.
 *    When a big diff filled it, the model had no room left to answer and the
 *    response came back truncated — which surfaces as a JSON parse failure, i.e.
 *    a review that produced NOTHING, from a review that had all the context it
 *    needed. pr-agent reserves a soft and a hard buffer for exactly this.
 *    → `fitFilesToBudget`.
 *
 * 3. SILENT DROPPING. When files did not fit they simply were not mentioned, so
 *    the model believed it had seen the whole MR and reasoned accordingly ("this
 *    caller is never updated" — it is, in a file you did not show it).
 *    pr-agent lists the omitted files by name under "Additional modified
 *    files". That costs a handful of tokens and converts a wrong answer into a
 *    stated limitation. It is the same failure `HunkWindower`'s rule 3 guards
 *    against, one level up.
 *    → `renderOmittedFiles`.
 */

import { parsePatchHunks } from './patchLines.js';
import { classifyDeletionHunk } from './deletionSignificance.js';

export const DIFF_BUDGET_DEFAULTS = Object.freeze({
    /**
     * Tokens held back for the model's own response. Below this much headroom,
     * stop adding whole files.
     *
     * pr-agent uses 1500/1000. RepoSpector asks for a much larger JSON object
     * than pr-agent does — findings with `evidence`, `suggestedFix`, and a
     * per-file verdict — so the reserve is bigger. A truncated response costs the
     * entire review unit; an omitted file costs one file.
     */
    softReserveTokens: 4000,
    /** Below this, stop adding anything at all, including a partial patch. */
    hardReserveTokens: 2500,
    /** Refuse to spend more than this share of the window on diff text. */
    maxDiffShare: 0.6,
    /** Chars per token for the cheap estimator. Matches TokenManager's ratio. */
    charsPerToken: 4,
});

/** Cheap, dependency-free token estimate. Callers may inject a real counter. */
export function estimateTokens(text, charsPerToken = DIFF_BUDGET_DEFAULTS.charsPerToken) {
    if (!text) return 0;
    return Math.ceil(String(text).length / charsPerToken);
}

/**
 * Drop hunks that only remove lines — EXCEPT the removals that change behaviour.
 *
 * Kept deliberately narrow in the other direction too: a hunk with even one
 * added line stays whole, because a `-`/`+` pair is a MODIFICATION and the
 * removed side is what makes the change legible ("this used to check for null").
 *
 * P1-1: this used to drop every deletion-only hunk unconditionally, on the
 * claim that a removal has nothing to review. Deleting an authorization check,
 * a rollback, a resource release, an exported symbol or the only test for a
 * branch is a behaviour change, and it was being removed from the prompt before
 * the model ever saw it. `classifyDeletionHunk` decides; unmatched removals are
 * still stripped, which keeps the token saving on the refactors and file moves
 * this guard was written for. Pass `keepSignificant: false` for the old
 * unconditional behaviour.
 *
 * A patch whose every hunk is deletion-only AND insignificant returns '' — the
 * caller should then render the file as name-only (see `renderOmittedFiles`),
 * not as an empty diff, since "here is the diff:" followed by nothing reads as
 * a fetch failure.
 *
 * @param {string} patch
 * @param {{keepSignificant?: boolean}} [options]
 * @returns {{patch:string, removedHunks:number, keptHunks:number,
 *            keptDeletionHunks:number, deletionSignals:Array}}
 */
export function stripDeletionOnlyHunks(patch, options = {}) {
    const keepSignificant = options.keepSignificant !== false;
    if (!patch || typeof patch !== 'string') {
        return {
            patch: patch || '', removedHunks: 0, keptHunks: 0,
            keptDeletionHunks: 0, deletionSignals: [],
        };
    }

    const lines = patch.split('\n');
    const out = [];
    let removedHunks = 0;
    let keptHunks = 0;
    let keptDeletionHunks = 0;
    const deletionSignals = [];
    const removedHunkHeaders = [];

    // Buffer each hunk (header + body) and decide when the next header arrives.
    let current = null;
    const flush = () => {
        if (!current) return;
        if (current.hasAdded) {
            out.push(...current.lines);
            keptHunks++;
            current = null;
            return;
        }
        const verdict = keepSignificant
            ? classifyDeletionHunk(current.lines)
            : { significant: false, signals: [] };
        if (verdict.significant) {
            out.push(...current.lines);
            keptHunks++;
            keptDeletionHunks++;
            deletionSignals.push({ header: current.lines[0], signals: verdict.signals });
        } else {
            removedHunks++;
            // Named, not just counted: coverage has to be able to say WHICH
            // hunk was left out, or "no findings here" is unfalsifiable (P1-5).
            removedHunkHeaders.push(current.lines[0]);
        }
        current = null;
    };

    for (const line of lines) {
        if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)) {
            flush();
            current = { lines: [line], hasAdded: false };
            continue;
        }
        if (!current) {
            // Preamble (---/+++/index lines) is passed through untouched.
            out.push(line);
            continue;
        }
        current.lines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) current.hasAdded = true;
    }
    flush();

    // Nothing survived: report the empty patch rather than a header-only diff.
    if (keptHunks === 0) {
        return {
            patch: '', removedHunks, keptHunks, keptDeletionHunks,
            deletionSignals, removedHunkHeaders,
        };
    }

    return {
        patch: out.join('\n'), removedHunks, keptHunks, keptDeletionHunks,
        deletionSignals, removedHunkHeaders,
    };
}

/**
 * Does this patch contain anything reviewable?
 * @param {string} patch
 */
export function hasReviewableChange(patch) {
    for (const h of parsePatchHunks(patch)) {
        if (h.lines.some(l => l.type === 'added')) return true;
    }
    return false;
}

/**
 * Decide which files' patches fit the prompt, in the order given.
 *
 * ORDER IS THE CALLER'S. pr-agent sorts by token count descending; RepoSpector
 * already ranks review units by risk (`FileGroupingStrategy`, and the
 * largest-diff-first ordering in `ReviewFileContextService`), and that ranking
 * is better than "biggest first". Re-sorting here would silently override it.
 *
 * @param {Object} args
 * @param {Array<{filename:string, patch?:string, status?:string, additions?:number, deletions?:number}>} args.files
 * @param {number} args.contextWindowTokens - the model's total window
 * @param {number} [args.promptTokens=0] - tokens already spent on everything else
 * @param {Function} [args.countTokens] - (text) => number
 * @param {Object} [args.options]
 * @returns {{included:Array, omitted:Array, stats:Object}}
 */
export function fitFilesToBudget({
    files = [],
    contextWindowTokens = 0,
    promptTokens = 0,
    countTokens = estimateTokens,
    options = {},
} = {}) {
    const opts = { ...DIFF_BUDGET_DEFAULTS, ...(options || {}) };
    const included = [];
    const omitted = [];
    const stats = {
        filesIn: 0, filesOut: 0, diffTokens: 0,
        deletionOnlyHunksRemoved: 0, deletionOnlyHunksKept: 0, budgetTokens: 0,
        stoppedEarly: false,
        // Which behavioural signals kept a removal in the prompt, so the report
        // can say "the authorization guard removed here was reviewed" rather
        // than leaving it to be inferred from the absence of a finding.
        deletionSignals: [],
        /** Every hunk this budget declined to send, named. */
        omittedHunks: [],
    };

    // No window figure means no budget to enforce. Include everything rather than
    // guessing a ceiling — a wrong guess here silently truncates real reviews.
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
        for (const f of files) included.push({ ...f, patch: f.patch || '' });
        stats.filesIn = included.length;
        return { included, omitted, stats };
    }

    const shareCap = Math.floor(contextWindowTokens * opts.maxDiffShare);
    const windowLeft = contextWindowTokens - promptTokens - opts.softReserveTokens;
    const budget = Math.max(0, Math.min(shareCap, windowLeft));
    stats.budgetTokens = budget;

    const hardFloor = contextWindowTokens - promptTokens - opts.hardReserveTokens;

    let spent = 0;

    for (const file of files) {
        const stripped = stripDeletionOnlyHunks(file.patch || '');
        stats.deletionOnlyHunksRemoved += stripped.removedHunks;
        stats.deletionOnlyHunksKept += stripped.keptDeletionHunks ?? 0;
        for (const entry of stripped.deletionSignals ?? []) {
            stats.deletionSignals.push({ file: file.filename ?? null, ...entry });
        }
        for (const header of stripped.removedHunkHeaders ?? []) {
            stats.omittedHunks.push({
                file: file.filename ?? null,
                hunk: header,
                reason: 'deletion-only hunk with no behavioural signal',
            });
        }

        if (!stripped.patch) {
            // Deletion-only or empty: name it, don't render an empty diff block.
            omitted.push({ ...file, omittedBecause: 'no added lines' });
            stats.filesOut++;
            continue;
        }

        const cost = countTokens(stripped.patch);

        if (spent + cost > budget || spent + cost > hardFloor) {
            omitted.push({ ...file, omittedBecause: 'budget' });
            stats.filesOut++;
            stats.stoppedEarly = true;
            for (const hunk of stripped.patch.split('\n').filter(l => l.startsWith('@@'))) {
                stats.omittedHunks.push({
                    file: file.filename ?? null,
                    hunk,
                    reason: 'diff budget exhausted',
                });
            }
            continue;
        }

        included.push({ ...file, patch: stripped.patch });
        spent += cost;
        stats.filesIn++;
    }

    stats.diffTokens = spent;
    return { included, omitted, stats };
}

/**
 * Render the omitted files as a name-only section for the prompt.
 *
 * Deleted files get their own list, as in pr-agent: "this file is gone" is a
 * fact a reviewer needs and it costs one line, whereas the deletion diff itself
 * costs the whole file.
 *
 * @param {Array<{filename:string, status?:string, additions?:number, deletions?:number, omittedBecause?:string}>} omitted
 * @returns {string} '' when nothing was omitted
 */
export function renderOmittedFiles(omitted = [], omittedHunks = []) {
    if (!omitted.length && !omittedHunks.length) return '';

    const isDeleted = (f) => f.status === 'removed' || f.status === 'deleted';
    const deleted = omitted.filter(isDeleted);
    const rest = omitted.filter(f => !isDeleted(f));

    const out = [
        '#### Files changed by this PR but NOT shown above',
        '',
        'These files are part of the same change. Their contents are not included,',
        'so do not conclude anything about them — in particular, do not report that',
        'a caller was "not updated" or a test is "missing" if it could live here.',
        '',
    ];

    if (rest.length) {
        for (const f of rest) {
            const churn = (f.additions || f.deletions)
                ? ` (+${f.additions || 0} -${f.deletions || 0})`
                : '';
            out.push(`- ${f.filename}${churn}${f.omittedBecause === 'no added lines' ? ' — removals only' : ''}`);
        }
    }

    if (deleted.length) {
        out.push('', 'Deleted files:');
        for (const f of deleted) out.push(`- ${f.filename}`);
    }

    // P1-5: hunk-level coverage. A file can be shown while some of its hunks
    // were dropped, and until now nothing said so — the model saw a partial
    // diff labelled as the diff.
    if (omittedHunks.length) {
        out.push('', 'Hunks not shown (from files that ARE above):');
        for (const h of omittedHunks.slice(0, 40)) {
            out.push(`- ${h.file ?? '?'} ${h.hunk ?? ''} — ${h.reason}`);
        }
        if (omittedHunks.length > 40) {
            out.push(`- …and ${omittedHunks.length - 40} more`);
        }
    }

    return `${out.join('\n')}\n`;
}

export default {
    stripDeletionOnlyHunks,
    hasReviewableChange,
    fitFilesToBudget,
    renderOmittedFiles,
    estimateTokens,
    DIFF_BUDGET_DEFAULTS,
};

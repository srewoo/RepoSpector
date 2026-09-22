/**
 * changedLineSeverity — a rule whose defect-ness depends on being INTRODUCED.
 *
 * `ts/eqeqeq` reports `==` at severity `low`, category `quality`, and for
 * pre-existing code that is the right call: a loose comparison that has been
 * there for years is a style observation, and this reviewer deliberately drops
 * those (`genuineProblemGate` rejects every `low`/`info`/`nit` finding as
 * `non-problem-severity`). Reporting them all is the noise this pipeline exists
 * to suppress.
 *
 * A loose comparison the change ITSELF introduces is a different claim. Someone
 * edited that line and the comparison semantics moved with it: `x == undefined`
 * also matches `null`, `x == 0` also matches `false` and `''`. That is a
 * behavioural change made by this diff, which is exactly what a diff review is
 * for — and measured on this corpus it was being detected and then discarded,
 * because the severity was assigned without knowing whether the line was new.
 *
 * So: same rule, same detection, severity decided by whether the line is added.
 *
 * The allowlist is deliberately two entries. This is not a general "promote
 * static findings on changed lines" policy — that would re-admit every style
 * rule through the back door and undo the precision the gate buys. A rule earns
 * a place here only when being newly written is what makes it a defect.
 */

import { addedLines } from './patchLines.js';

/**
 * ruleId → how to restate it once we know the line is new.
 *
 * The CATEGORY moves as well as the severity, for the same reason and with the
 * same justification: `quality` sits in `findingClaim.COMMENTARY_CATEGORIES`, so
 * a finding wearing it is classified as commentary before its severity is ever
 * read. That is the right default for a loose comparison someone wrote years
 * ago. A comparison this diff introduces is a change in behaviour, which is
 * `correctness`.
 *
 * The message is rewritten as well as the severity because a gate downstream
 * reads the prose: `lowValueGate` demotes anything that reads as a preference,
 * and "Use === instead of ==" reads as exactly that. The promoted form states
 * the behavioural consequence instead, which is both truer and what makes it
 * survive on its merits rather than on a severity number.
 */
export const INTRODUCED_RULES = new Map([
    ['ts/eqeqeq', {
        severity: 'medium',
        category: 'correctness',
        message: 'This change introduces a loose comparison (== / !=). Loose equality applies '
            + 'type coercion, so it also matches values the strict form would reject — '
            + '`x == undefined` is true for `null`, and `x == 0` is true for `false` and `""`. '
            + 'If that widening is intended, say so; otherwise use === / !==.',
    }],
    ['rs/eqeqeq', {
        severity: 'medium',
        category: 'correctness',
        message: 'This change introduces a loose comparison (== / !=). Loose equality applies '
            + 'type coercion, so it also matches values the strict form would reject — '
            + '`x == undefined` is true for `null`, and `x == 0` is true for `false` and `""`. '
            + 'If that widening is intended, say so; otherwise use === / !==.',
    }],
]);

/** path → Set of new-side line numbers this change ADDED (not context, not removed). */
export function addedLineIndex(files) {
    const index = new Map();
    for (const f of files ?? []) {
        const path = f.filename ?? f.new_path ?? f.path;
        if (!path) continue;
        index.set(path, addedLines(f.patch ?? f.diff ?? ''));
    }
    return index;
}

const pathOf = (f) => String(f?.filePath ?? f?.file ?? f?.path ?? '').trim();

/**
 * Re-severitise allowlisted rules that landed on a line this change added.
 *
 * Findings are returned in input order; anything not on the allowlist, or not on
 * an added line, is passed through untouched. Nothing is dropped here.
 *
 * @param {Array<object>} findings
 * @param {Array<object>} files - the change's files, each with a `patch`
 * @returns {{findings: Array<object>, promoted: number}}
 */
export function promoteIntroducedFindings(findings, files) {
    const list = Array.isArray(findings) ? findings : [];
    if (!list.length) return { findings: list, promoted: 0 };

    const index = addedLineIndex(files);
    if (index.size === 0) return { findings: list, promoted: 0 };

    let promoted = 0;
    const out = list.map((f) => {
        const rule = INTRODUCED_RULES.get(String(f?.ruleId ?? f?.rule ?? ''));
        if (!rule) return f;

        const added = index.get(pathOf(f));
        const line = Number(f?.line);
        if (!added || !Number.isFinite(line) || !added.has(line)) return f;

        promoted++;
        return {
            ...f,
            severity: rule.severity,
            category: rule.category,
            message: rule.message,
            // Kept so a reader (and any later gate) can see WHY this is not the
            // style note the same rule produces elsewhere in the file.
            introducedByChange: true,
        };
    });

    return { findings: out, promoted };
}

export default { promoteIntroducedFindings, addedLineIndex, INTRODUCED_RULES };

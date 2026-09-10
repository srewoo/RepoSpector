/**
 * fixValidation — a suggested fix that does not apply is worse than none. P1-6.
 *
 * `FixRecommendationService` attaches a `suggestedFix` with an `original` and a
 * `replacement` and nothing checked either. Three failure modes reached
 * reviewers:
 *
 *   The `original` is not in the file. The model reconstructed the line from
 *   memory of the diff, got the indentation or a variable name slightly wrong,
 *   and the patch cannot be applied by anyone — including by a human reading
 *   it, who now has to work out which of the two versions is real.
 *
 *   The `replacement` does not parse. A fix that introduces a syntax error is
 *   an unambiguous regression presented as a correction.
 *
 *   The `replacement` is identical to the `original`. A no-op rendered as a
 *   suggestion, which costs the reviewer the time to spot that nothing changed.
 *
 * The plan's P1-6 acceptance names this directly: *invalid candidate fixes are
 * rejected*. Rejected, not silently repaired — a fix we cannot verify is
 * removed and the FINDING is kept, because the defect may well be real even
 * when the proposed correction is not.
 */

import { quickValidate } from './syntaxValidator.js';

export const FIX_REJECTION = Object.freeze({
    ORIGINAL_ABSENT: 'original-not-in-file',
    NO_OP: 'replacement-identical-to-original',
    UNPARSEABLE: 'replacement-does-not-parse',
    EMPTY: 'fix-has-no-replacement',
});

/** Whitespace-insensitive, so a re-indented quote still matches. */
function normalize(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Does `original` actually appear in the file it claims to come from?
 *
 * Returns `null` — "cannot tell" — when there is no source, which is treated as
 * a reason to keep the fix rather than to reject it. Rejecting on absent
 * evidence would delete correct fixes on every patch-only review.
 */
export function originalPresent(original, fileSource) {
    if (!fileSource) return null;
    const needle = normalize(original);
    if (needle.length < 4) return null;
    return normalize(fileSource).includes(needle);
}

/**
 * @param {object} fix       `{ original, replacement, ... }`
 * @param {object} [context] `{ fileSource, filename }`
 * @returns {{valid: boolean, reason: string|null, detail: string|null}}
 */
export function validateFix(fix, context = {}) {
    const original = fix?.original ?? null;
    const replacement = fix?.replacement ?? null;

    if (replacement == null || !String(replacement).trim()) {
        return {
            valid: false,
            reason: FIX_REJECTION.EMPTY,
            detail: 'the fix proposes no replacement text',
        };
    }

    if (original != null && normalize(original) === normalize(replacement)) {
        return {
            valid: false,
            reason: FIX_REJECTION.NO_OP,
            detail: 'the replacement is identical to the original',
        };
    }

    if (original != null && originalPresent(original, context.fileSource) === false) {
        return {
            valid: false,
            reason: FIX_REJECTION.ORIGINAL_ABSENT,
            detail: 'the text the fix proposes to replace is not in this file, so the patch '
                + 'cannot be applied',
        };
    }

    // Delimiter balance, compared against the ORIGINAL rather than judged in
    // isolation.
    //
    // A suggested fix is a fragment, and a fragment is often legitimately
    // unbalanced — a hunk that opens a block and does not close it is normal,
    // so `quickValidate(replacement)` on its own would reject correct fixes all
    // day. What is never legitimate is a replacement whose balance DIFFERS from
    // the text it replaces: dropping a `}` that the original had turns a
    // correct file into a broken one, and that is a regression shipped as a
    // correction.
    if (original != null) {
        const drift = balanceDrift(original, replacement);
        if (drift) {
            return {
                valid: false,
                reason: FIX_REJECTION.UNPARSEABLE,
                detail: `the replacement does not balance with the code it replaces (${drift}), `
                    + 'so applying it would break the file',
            };
        }
    } else {
        // With nothing to compare against, fall back to the absolute check —
        // a standalone replacement really should be self-contained.
        const syntax = safeQuickValidate(replacement);
        if (syntax && syntax.valid === false) {
            return {
                valid: false,
                reason: FIX_REJECTION.UNPARSEABLE,
                detail: `the replacement does not parse: ${syntax.error ?? 'syntax error'}`,
            };
        }
    }

    return { valid: true, reason: null, detail: null };
}

/** Non-empty description of how the two texts' delimiter balance differs. */
export function balanceDrift(original, replacement) {
    const pairs = [['{', '}', 'braces'], ['(', ')', 'parentheses'], ['[', ']', 'brackets']];
    const count = (text, ch) => (String(text).split(ch).length - 1);
    const drifted = [];

    for (const [open, close, name] of pairs) {
        const before = count(original, open) - count(original, close);
        const after = count(replacement, open) - count(replacement, close);
        if (before !== after) drifted.push(name);
    }
    return drifted.length ? `unbalanced ${drifted.join(', ')}` : null;
}

function safeQuickValidate(code) {
    try {
        const result = quickValidate(code);
        return result && typeof result === 'object' ? result : null;
    } catch {
        return null;
    }
}

/**
 * Strip fixes that cannot be applied, keeping the findings that carried them.
 *
 * @returns {{findings: Array, stats: {checked:number, rejected:number, byReason:object}}}
 */
export function rejectInvalidFixes(findings = [], { sourceByFile = {} } = {}) {
    const stats = { checked: 0, rejected: 0, byReason: {} };

    const out = (findings || []).map((finding) => {
        const fix = finding?.suggestedFix;
        if (!fix) return finding;

        stats.checked++;
        const path = finding.file ?? finding.filePath ?? null;
        const verdict = validateFix(fix, {
            fileSource: path ? sourceByFile[path] ?? null : null,
            filename: path,
        });
        if (verdict.valid) return finding;

        stats.rejected++;
        stats.byReason[verdict.reason] = (stats.byReason[verdict.reason] || 0) + 1;

        // The finding survives; only the unusable fix is removed. A defect does
        // not stop being real because the proposed correction was wrong.
        const { suggestedFix: _dropped, ...rest } = finding;
        return {
            ...rest,
            rejectedFix: { ...fix, rejectedBecause: verdict.reason, detail: verdict.detail },
        };
    });

    return { findings: out, stats };
}

export default { validateFix, rejectInvalidFixes, originalPresent, FIX_REJECTION };

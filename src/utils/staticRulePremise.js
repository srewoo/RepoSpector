/**
 * staticRulePremise — check that a static rule's premise exists where it fired.
 *
 * From the four-adjudicator pass (`eval/README.md`, false-positive class 2):
 *
 *     "Static-rule findings whose premise no hunk contained — every no-dupe-keys
 *      / no-unreachable hit pointed at a hunk with no object literal and no dead
 *      code; several flagged the very unreachable code the diff deleted. This one
 *      is a static-analysis line-mapping problem, not an LLM problem, and is the
 *      most mechanically fixable class of the six."
 *
 * This is that fix. Every rule below is deterministic and local: `no-dupe-keys`
 * requires an object literal, `eqeqeq` requires a loose operator, `no-var`
 * requires `var`. If the rule's own construct is not at the line it fired on, the
 * mapping is wrong, and the finding is noise no matter how the rule is worded.
 *
 * ## Why static findings need their own gate
 *
 * `findingEvidence.js` extracts constructs from the finding TITLE — dotted calls,
 * backticked spans, long snake_case. A static rule's title is its rule id
 * (`no-dupe-keys`), which names no code, so GATE 4 extracts nothing and the
 * finding sails through every existing check. Static findings also bypass the LLM
 * refuter by design (they are "ground truth, not guesses"), so before this module
 * a mis-mapped static finding had NOTHING standing between it and the PR.
 *
 * ## Fail-open, always
 *
 * A rule with no predicate here passes untouched. The map is an allowlist of
 * checks we are sure of, not a filter everything must satisfy — a new rule should
 * never start being dropped merely because nobody taught this file about it.
 */

import { parsePatchHunks } from './patchLines.js';

/** Lines to look at either side of the cited line. */
const WINDOW = 2;

/** Strip line comments and string literals so a rule cannot match its own name in prose. */
function stripNoise(text) {
    return String(text || '')
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')   // string bodies
        .replace(/\/\/.*$/, '')                         // line comment
        .replace(/#.*$/, '')                            // hash comment
        .replace(/\/\*[\s\S]*?\*\//g, '');              // block comment
}

/**
 * rule id → predicate over { line, window }.
 *
 * `line` is the cited line alone; `window` is that line plus WINDOW either side,
 * joined — needed for constructs that legitimately span lines (an object literal,
 * a `catch` whose brace is on the next line). `before` is the window ABOVE the
 * cited line only, for rules whose premise is ordered.
 */
const PREMISE = {
    /**
     * The rule is no-DUPE-keys: an object literal is not enough, a key has to
     * actually repeat. Checking only for a literal passed 9 of 9 mis-mapped hits
     * on the measured corpus, because real diffs are full of object literals.
     * Requiring the duplicate makes the predicate mean what the rule means.
     */
    'no-dupe-keys': ({ window }) => {
        const keys = [...window.matchAll(/[{,]\s*['"`]?([\w$]+)['"`]?\s*:/g)].map(m => m[1]);
        return new Set(keys).size < keys.length;
    },

    /**
     * Unreachable code needs a terminator BEFORE it, not merely nearby. A
     * `return` two lines below the cited line makes nothing above it dead, and
     * accepting one passed most of the mis-mapped hits on the measured corpus.
     */
    'no-unreachable': ({ before }) => /\b(return|throw|break|continue|process\.exit|panic|raise)\b/.test(before),

    // Needs an actual catch/except clause.
    'no-empty-catch': ({ window }) => /\b(catch|except|rescue)\b/.test(window),

    // Needs a loose equality operator. `===` and `!==` must not count.
    eqeqeq: ({ line }) => /(^|[^=!<>])[=!]=(?!=)/.test(line),

    'no-var': ({ line }) => /\bvar\s+[\w$]/.test(line),
    'no-console': ({ line }) => /\bconsole\s*\./.test(line),
    'no-eval': ({ line }) => /\beval\s*\(/.test(line),
    'no-new-function': ({ line }) => /\bnew\s+Function\s*\(/.test(line),
    'no-implied-eval': ({ line }) => /\b(setTimeout|setInterval)\s*\(\s*['"`]/.test(line),
    'no-document-write': ({ line }) => /\bdocument\s*\.\s*write/.test(line),
    'no-innerhtml': ({ line }) => /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(line),
    'no-throw-literal': ({ line }) => /\bthrow\b/.test(line),
    'use-isnan': ({ line }) => /\bNaN\b/.test(line),
    'no-sparse-arrays': ({ line }) => /\[[^\]]*,\s*,/.test(line),
    'no-self-assign': ({ line }) => /=/.test(line),
    'no-sync-methods': ({ line }) => /\w+Sync\s*\(/.test(line),
    'no-await-in-loop': ({ window }) => /\bawait\b/.test(window) && /\b(for|while|forEach)\b/.test(window),
    'no-constant-condition': ({ line }) => /\b(if|while|for)\b/.test(line),
    'no-magic-numbers': ({ line }) => /\d/.test(line),
};

/**
 * Strip a namespace from a rule id: `static/no-dupe-keys` → `no-dupe-keys`.
 *
 * Not cosmetic. Findings carry the namespaced form (`source` is a separate
 * field), and keying the premise map on the bare id meant this gate silently
 * matched NOTHING on real data — it fired zero times across 22 static findings
 * that were all `no-dupe-keys` or `no-unreachable`, the exact two rules
 * adjudication singled out. A gate that cannot fire is worse than no gate,
 * because it reads as a check that passed.
 */
function normaliseRuleId(raw) {
    if (!raw) return null;
    const id = String(raw).trim();
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Map new-line number → source text, from a unified patch. */
function linesByNumber(patch) {
    const map = new Map();
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) {
            if (l.type !== 'deleted' && l.number.new != null) map.set(l.number.new, l.content);
        }
    }
    return map;
}

/**
 * Does this static finding's rule premise hold at the line it fired on?
 *
 * @param {object} finding - needs `ruleId` (or `rule`/`code`) and `line`
 * @param {string} patch - unified diff for the finding's file
 * @returns {{ok: boolean, reason: string|null, ruleId: string|null}}
 *          `ok: true` for every rule this module has no opinion about.
 */
export function checkStaticPremise(finding, patch) {
    const ruleId = normaliseRuleId(finding?.ruleId || finding?.rule || finding?.code);
    const ok = { ok: true, reason: null, ruleId };

    const predicate = ruleId && PREMISE[ruleId];
    if (!predicate) return ok;                     // unknown rule — fail open

    const line = Number(finding?.line);
    if (!Number.isFinite(line) || !patch) return ok;

    const byLine = linesByNumber(patch);
    if (byLine.size === 0) return ok;              // unparsed patch must not condemn

    const cited = byLine.get(line);
    // The cited line is not in the diff at all. That is GATE 1's job in
    // findingEvidence, with a better message; do not double-report it here.
    if (cited == null) return ok;

    const windowText = [];
    const beforeText = [];
    for (let l = line - WINDOW; l <= line + WINDOW; l++) {
        const text = byLine.get(l);
        if (text == null) continue;
        windowText.push(text);
        if (l < line) beforeText.push(text);
    }

    const context = {
        line: stripNoise(cited),
        window: stripNoise(windowText.join('\n')),
        // Strictly above the cited line — required by any rule whose premise is
        // ordered, like unreachability.
        before: stripNoise(beforeText.join('\n')),
    };

    if (predicate(context)) return ok;

    return {
        ok: false,
        ruleId,
        reason:
            `static rule \`${ruleId}\` fired on line ${line}, but that line and its neighbours contain ` +
            `no construct the rule applies to — the finding is mis-mapped, not a defect`,
    };
}

/** Rule ids this module can check. Exported so tests can assert coverage rather than guess. */
export const CHECKED_RULES = Object.freeze(Object.keys(PREMISE));

export default { checkStaticPremise, CHECKED_RULES };

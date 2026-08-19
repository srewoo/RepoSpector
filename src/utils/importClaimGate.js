/**
 * importClaimGate — refute "X is not imported" when the import is right there.
 *
 * Measured false-positive class 4: *"Premise contradicted by a line visible in
 * the hunk — e.g. claiming a symbol is never imported when the import is in the
 * shown context."* On the 22-PR corpus this shape accounts for 6 adjudicated
 * false positives and **zero** true positives:
 *
 *     "NameError: union_categoricals used without import"
 *     "fmt.Errorf used but fmt not imported"
 *     "Missing import for bytes package used on this line"
 *
 * Each is a confident, specific, checkable claim — and the check is a string
 * search over the patch the model was already shown.
 *
 * ## Fails open, and that is the whole safety argument
 *
 * A diff shows a window, not a file. If the import is not visible, its absence is
 * NOT evidence — the import block usually sits far above the changed lines and
 * simply is not in the patch. So this gate refutes in one direction only: it
 * fires when the import is PRESENT, and stays silent whenever it cannot see one.
 *
 * That asymmetry is deliberate. Refuting on "no import visible" would delete the
 * genuine missing-import bugs this reviewer should be catching, which is the
 * expensive direction everywhere in this pipeline.
 */

import { parsePatchHunks } from './patchLines.js';

/**
 * Claims about a missing import. Deliberately import-specific: an earlier draft
 * matched a bare "used without", which also catches "used without validation" —
 * a nil-check finding that has nothing to do with imports.
 */
const IMPORT_CLAIM =
    /\b(missing import|not imported|without an? import|without importing|un-?imported|NameError|undefined name|import (?:is |was )?missing|lacks? the [\w.]+ import|no import (?:for|of))\b/i;

/** Lines that introduce a name into scope, across the languages reviewed here. */
const IMPORT_LINE = /^\s*(?:import\b|from\s+[\w.]+\s+import\b|const\s+.*=\s*require\(|.*\brequire\(|use\s+|#include\b|using\s+)/;

/**
 * Symbols the claim says are missing.
 *
 * Both halves of a qualified name are candidates: "fmt.Errorf used but fmt not
 * imported" names the call, while the import line only ever carries the package
 * (`fmt`). Checking the qualifier alone would miss the call form and vice versa.
 */
export function claimedSymbols(text) {
    const out = new Set();
    if (!text) return [];

    for (const m of String(text).matchAll(/`([^`\n]{2,60})`/g)) {
        const tok = m[1].trim().replace(/\(.*$/, '').trim();
        if (/^[A-Za-z_$][\w$.]*$/.test(tok)) out.add(tok);
    }
    for (const m of String(text).matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
        out.add(m[1]);
    }
    for (const m of String(text).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi)) {
        out.add(m[1]);
    }

    // Bare and dotted identifiers as they appear in prose. Required, not
    // optional: the claims this gate exists for are written as plain English —
    // "fmt not imported", "Missing import for bytes package" — with no
    // parentheses, backticks or underscores to key on, so the narrower patterns
    // above extracted NOTHING from any of them.
    //
    // Over-extraction is safe here in a way it would not be elsewhere: a symbol
    // only does anything if it also appears on an import line, so an English word
    // that is not a package name simply never matches.
    for (const m of String(text).matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/g)) {
        out.add(m[1]);
    }

    // Add the leading qualifier of any dotted name: `fmt.Errorf` → `fmt`.
    for (const tok of [...out]) {
        if (tok.includes('.')) out.add(tok.split('.')[0]);
    }

    // Words that appear in these claims but are never the missing symbol. Kept
    // deliberately wide: a stray English word that also occurs on an import line
    // is the only way this gate can misfire.
    const NOISE = new Set([
        'import', 'imports', 'imported', 'importing', 'name', 'names', 'this', 'that',
        'line', 'lines', 'file', 'package', 'packages', 'module', 'modules', 'function',
        'call', 'calls', 'called', 'used', 'uses', 'using', 'use', 'not', 'but', 'and',
        'the', 'for', 'from', 'with', 'without', 'missing', 'undefined', 'error',
        'errors', 'new', 'code', 'here', 'has', 'have', 'are', 'was', 'will', 'may',
        'might', 'could', 'causing', 'cause', 'compile', 'reference', 'references',
        'requires', 'require', 'needs', 'need', 'shown', 'list', 'lacks', 'lack',
    ]);
    return [...out].filter(t => t.length >= 3 && !NOISE.has(t.toLowerCase()));
}

/** Every line of the patch that brings a name into scope. */
function importLines(patch) {
    const out = [];
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) {
            // Deleted imports do not count — a removed import genuinely is gone.
            if (l.type !== 'deleted' && IMPORT_LINE.test(l.content)) out.push(l.content);
        }
    }
    return out;
}

/**
 * Is a "missing import" claim contradicted by an import visible in the diff?
 *
 * @param {object} finding
 * @param {string} patch - unified diff for the finding's file
 * @returns {{refuted: boolean, reason: string|null, symbol: string|null}}
 */
export function assessImportClaim(finding, patch) {
    const none = { refuted: false, reason: null, symbol: null };
    if (!patch) return none;

    const claim = [finding?.title, finding?.description, finding?.message].filter(Boolean).join(' ');
    if (!claim || !IMPORT_CLAIM.test(claim)) return none;

    const imports = importLines(patch);
    if (imports.length === 0) return none;   // nothing visible — absence proves nothing

    for (const symbol of claimedSymbols(claim)) {
        const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Word-ish boundary so `bytes` does not match `bytesutil`, and a path
        // segment match so Go's `"encoding/json"` satisfies a claim about `json`.
        const re = new RegExp(`(^|[^\\w$])${esc}(?![\\w$])`);
        const hit = imports.find(l => re.test(l));
        if (hit) {
            return {
                refuted: true,
                symbol,
                reason:
                    `the finding claims \`${symbol}\` is not imported, but this file's diff contains ` +
                    `\`${hit.trim().slice(0, 80)}\` — the premise is contradicted by a line the model was shown`,
            };
        }
    }
    return none;
}

export default { assessImportClaim, claimedSymbols };

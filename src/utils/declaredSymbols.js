/**
 * declaredSymbols — what does this diff actually DEFINE?
 *
 * Extracted from ReviewGraphContextService, which needed it to ask the code
 * graph precise questions per symbol. ReviewReuseContextService needs exactly
 * the same set for a different question ("does this already exist elsewhere?"),
 * and two copies of eight language regexes would drift the moment either grew
 * a pattern.
 *
 * Matching the DECLARATION rather than every mention is the whole point: a diff
 * mentions hundreds of identifiers and usually defines a handful, and it is the
 * handful that both callers care about.
 */

/** Identifiers that are never worth a lookup. */
export const NOISE = new Set([
    'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var',
    'class', 'new', 'this', 'true', 'false', 'null', 'undefined', 'import',
    'export', 'default', 'async', 'await', 'try', 'catch', 'throw', 'typeof',
    'def', 'self', 'func', 'type', 'struct', 'interface', 'package', 'public',
    'private', 'static', 'void', 'int', 'string', 'bool', 'err', 'nil',
]);

/**
 * Declaration patterns across the languages RepoSpector supports.
 *
 * Every pattern must capture the declared name as group 1. They carry the `g`
 * flag and are module-level, so `lastIndex` is reset before each use — see
 * `extractDeclaredSymbols`.
 */
export const DECL_PATTERNS = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,   // js/ts
    /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,   // js/ts/py
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, // js arrow fn
    /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, // ts
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm,                   // python
    /func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,                   // go
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm, // java-ish
    /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,                   // bare method
];

/** Shortest name worth looking up. Below this, matches are overwhelmingly noise. */
const MIN_NAME_LENGTH = 3;

/**
 * Symbols DECLARED (not merely mentioned) in a block of code.
 *
 * @param {string} code
 * @returns {string[]} unique names, in first-seen order per pattern
 */
export function extractDeclaredSymbols(code) {
    if (!code || typeof code !== 'string') return [];
    const found = new Set();
    for (const pattern of DECL_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(code)) !== null) {
            const name = m[1];
            if (!name || name.length < MIN_NAME_LENGTH) continue;
            if (NOISE.has(name) || NOISE.has(name.toLowerCase())) continue;
            found.add(name);
        }
    }
    return [...found];
}

/** Extract just the added ("+") lines from a unified diff patch. */
export function addedLines(patch) {
    if (!patch || typeof patch !== 'string') return '';
    return patch
        .split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1))
        .join('\n');
}

/**
 * The added line that declares `symbol`, for use as retrieval context.
 *
 * A bare symbol name is a weak query — `save` matches half a codebase. The
 * declaration line carries the parameter names and types that make a similarity
 * search discriminating.
 *
 * @returns {string} the trimmed declaring line, or '' when not found
 */
export function declarationLineFor(code, symbol) {
    if (!code || !symbol) return '';
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(`\\b${escaped}\\b`);
    for (const line of String(code).split('\n')) {
        if (!boundary.test(line)) continue;
        // Only a line that DECLARES it, not one that calls it.
        for (const pattern of DECL_PATTERNS) {
            pattern.lastIndex = 0;
            let m;
            while ((m = pattern.exec(line)) !== null) {
                if (m[1] === symbol) return line.trim();
            }
        }
    }
    return '';
}

/**
 * Does `code` DECLARE `symbol`? Exact, and deliberately not filtered by
 * MIN_NAME_LENGTH — unlike `extractDeclaredSymbols`, the caller here already
 * knows the name it is asking about, so a short name is a real question.
 *
 * Relies on the contract stated above DECL_PATTERNS: every pattern captures the
 * declared name as group 1.
 */
export function declaresSymbol(code, symbol) {
    if (!code || !symbol) return false;
    for (const pattern of DECL_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(code)) !== null) {
            if (m[1] === symbol) { pattern.lastIndex = 0; return true; }
            // Zero-width match guard: these patterns are module-level and /g.
            if (m.index === pattern.lastIndex) pattern.lastIndex++;
        }
        pattern.lastIndex = 0;
    }
    return false;
}

/**
 * New-file line number of the first "+" line that DECLARES `symbol`.
 * Walks hunk headers so the number is what GitHub/GitLab will accept for an
 * inline comment. Returns null when nothing on a "+" line declares it.
 */
export function declarationNewLine(patch, symbol) {
    if (!patch || !symbol) return null;
    let newLine = 0;
    for (const raw of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) { newLine = Number(hunk[1]) - 1; continue; }
        if (raw.startsWith('-')) continue;
        newLine++;
        if (!raw.startsWith('+')) continue;
        if (declaresSymbol(raw.slice(1), symbol)) return newLine;
    }
    return null;
}

export default {
    NOISE,
    DECL_PATTERNS,
    extractDeclaredSymbols,
    addedLines,
    declarationLineFor,
    declaresSymbol,
    declarationNewLine,
};

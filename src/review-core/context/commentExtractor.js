/**
 * commentExtractor — the comments near a change, by language.
 *
 * Feeds the `codeComments` lens: guidance like "must stay sorted" or "do not
 * call from the UI thread" lives in comments next to the code it governs.
 * No keyword filter — the lens decides what is guidance.
 *
 * ponytail: line scanner, not a tokenizer. A comment marker inside a string
 * literal ("#fff", "a // b") is read as a comment. `//` after `:` is skipped so
 * URLs are not. Upgrade to a real tokenizer only if the lens is measurably
 * misled by it.
 */

const C_LINE = { line: ['//'], block: [['/*', '*/']] };
const HASH = { line: ['#'], block: [] };
const HTML = { line: [], block: [['<!--', '-->']] };

const SYNTAX_BY_EXT = {
    ...Object.fromEntries(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'java', 'kt', 'kts', 'go', 'c', 'h', 'cc', 'cpp', 'hpp',
        'cs', 'swift', 'rs', 'scala', 'dart', 'css', 'scss', 'less', 'groovy'].map(e => [e, C_LINE])),
    ...Object.fromEntries(['rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'pl', 'r', 'cfg', 'conf', 'mk'].map(e => [e, HASH])),
    ...Object.fromEntries(['html', 'htm', 'xml', 'md', 'svg'].map(e => [e, HTML])),
    py: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] },
    php: { line: ['//', '#'], block: [['/*', '*/']] },
    vue: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] },
    svelte: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] },
};
const FALLBACK = { line: ['//', '#'], block: [] };

function syntaxFor(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (name === 'makefile' || name === 'dockerfile') return HASH;
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return SYNTAX_BY_EXT[ext] || FALLBACK;
}

/** Index of a line marker, or -1. `//` after ':' (a URL) and `#` glued to a word do not count. */
function lineMarkerAt(text, marker) {
    let from = 0;
    while (from <= text.length) {
        const i = text.indexOf(marker, from);
        if (i < 0) return -1;
        const prev = i > 0 ? text[i - 1] : '';
        if (marker === '//' && prev === ':') { from = i + 2; continue; }
        if (marker === '#' && prev && !/\s/.test(prev)) { from = i + 1; continue; }
        return i;
    }
    return -1;
}

/** The earliest comment opener on this line: {kind, index, open, close?}. */
function firstOpener(text, syntax) {
    let best = null;
    for (const m of syntax.line) {
        const i = lineMarkerAt(text, m);
        if (i >= 0 && (!best || i < best.index)) best = { kind: 'line', index: i, open: m };
    }
    for (const [open, close] of syntax.block) {
        const i = text.indexOf(open);
        if (i >= 0 && (!best || i < best.index)) best = { kind: 'block', index: i, open, close };
    }
    return best;
}

const clean = (s) => s.replace(/^\s*\*+\s?/, '').replace(/\s*\*+\s*$/, '').trim();

/**
 * @param {string} text - the whole file
 * @param {string} path - used only for its extension
 * @param {Object} [opts]
 * @param {number[]} [opts.aroundLines] - 1-based lines to centre windows on; omitted/empty = whole file
 * @param {number} [opts.radius=40]
 * @returns {Array<{line:number, text:string}>}
 */
export function extractComments(text, path, { aroundLines = [], radius = 40 } = {}) {
    const syntax = syntaxFor(path);
    const centres = (aroundLines || []).filter(Number.isInteger);
    const near = (n) => centres.length === 0 || centres.some(c => Math.abs(c - n) <= radius);
    const out = [];
    const emit = (line, body) => {
        const t = clean(body);
        if (t && near(line)) out.push({ line, text: t });
    };

    let openBlock = null; // the close marker we are waiting for
    String(text || '').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        if (openBlock) {
            const end = raw.indexOf(openBlock);
            emit(lineNo, end >= 0 ? raw.slice(0, end) : raw);
            if (end >= 0) openBlock = null;
            return;
        }
        const op = firstOpener(raw, syntax);
        if (!op) return;
        const rest = raw.slice(op.index + op.open.length);
        if (op.kind === 'line') return emit(lineNo, rest);
        const end = rest.indexOf(op.close);
        emit(lineNo, end >= 0 ? rest.slice(0, end) : rest);
        if (end < 0) openBlock = op.close;
    });
    return out;
}

export default { extractComments };

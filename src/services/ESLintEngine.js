/**
 * ASTLintEngine — a REAL AST static analyzer (not regex).
 *
 * Parses JavaScript/JSX to a full ESTree AST with `acorn` (the same parser that
 * sits under ESLint/espree — browser-safe and already a dependency) and matches
 * defects structurally with AST visitors. This is the genuine engine replacement
 * for the regex ESLint layer on the JS path.
 *
 * Why acorn and not the `eslint` package: ESLint's npm entrypoint pulls in `fs`
 * and its own package.json and does not bundle into an MV3 service worker. acorn is
 * pure, tiny, browser-safe, and gives us the real AST — so the structural rules
 * below run in the shipped extension, not just in Node.
 *
 * Honest limits:
 *  - JavaScript / JSX only. TypeScript-specific syntax won't parse → caller falls
 *    back to the regex analyzer for .ts/.tsx.
 *  - Needs full, parseable source. A partial diff hunk that won't parse yields
 *    ok:false so the caller falls back to regex rather than emitting noise.
 */

let acornParser = null;
let acornLoadFailed = false;

async function getParser() {
    if (acornParser || acornLoadFailed) return acornParser;
    try {
        const [{ Parser }, jsxMod] = await Promise.all([import('acorn'), import('acorn-jsx')]);
        const jsx = jsxMod.default || jsxMod;
        acornParser = Parser.extend(jsx());
    } catch (e) {
        console.warn('ASTLintEngine: acorn unavailable, falling back to regex:', e?.message);
        acornLoadFailed = true;
    }
    return acornParser;
}

const RULE_META = {
    // ── security ──
    'rs/no-eval-nonliteral': { severity: 'critical', category: 'security', cwe: 'CWE-95', message: 'eval()/new Function() called with a non-literal argument — code injection risk.' },
    'rs/no-child-process-concat': { severity: 'critical', category: 'security', cwe: 'CWE-78', message: 'Shell command built from a non-literal (concatenation/template) — command injection risk.' },
    'rs/no-sql-concat': { severity: 'high', category: 'security', cwe: 'CWE-89', message: 'SQL/query string built by concatenation with a variable — use parameterized queries.' },
    'rs/no-hardcoded-secret': { severity: 'high', category: 'security', cwe: 'CWE-798', message: 'Possible hardcoded secret/credential assigned to a secret-named identifier.' },
    'rs/no-inner-html-nonliteral': { severity: 'high', category: 'security', cwe: 'CWE-79', message: 'innerHTML/outerHTML assigned a non-literal value — XSS risk. Sanitize or use textContent.' },
    'rs/no-document-write': { severity: 'medium', category: 'security', cwe: 'CWE-79', message: 'document.write() is an XSS sink; use safe DOM APIs.' },
    'rs/no-weak-hash': { severity: 'medium', category: 'security', cwe: 'CWE-327', message: 'Weak hash algorithm (md5/sha1) — use SHA-256 or better.' },
    // ── correctness / quality ──
    'rs/eqeqeq': { severity: 'low', category: 'quality', cwe: null, message: 'Use === / !== instead of == / != to avoid type coercion bugs.' },
    'rs/no-constant-condition': { severity: 'medium', category: 'bug', cwe: null, message: 'Constant condition — this branch/loop test never varies.' },
    'rs/no-debugger': { severity: 'medium', category: 'quality', cwe: null, message: 'debugger statement left in code.' },
    'rs/no-empty-catch': { severity: 'medium', category: 'bug', cwe: null, message: 'Empty catch block swallows the error silently.' }
};

// ── AST helpers ──
function isNonLiteral(node) {
    return node && node.type !== 'Literal' && !(node.type === 'TemplateLiteral' && node.expressions.length === 0);
}
function calleeName(node) {
    const c = node.callee;
    if (!c) return '';
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression' && c.property) return c.property.name || '';
    return '';
}
function objectName(node) {
    const c = node.callee;
    if (c && c.type === 'MemberExpression' && c.object && c.object.type === 'Identifier') return c.object.name;
    return '';
}
const SECRET_RE = /(secret|passwd|password|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|client[_-]?secret)/i;
const EXECS = new Set(['exec', 'execSync', 'spawn', 'spawnSync', 'execFile']);
const SQL_CALLS = /^(query|execute|exec|raw|prepare)$/i;
const looksSql = (s) => /\b(select|insert|update|delete|where|from)\b/i.test(s);

// ── per-node rule dispatch. Each returns a ruleId (or null). ──
function checkNode(node) {
    const hits = [];
    const t = node.type;

    if (t === 'CallExpression') {
        if (node.callee && node.callee.name === 'eval' && isNonLiteral(node.arguments[0])) hits.push('rs/no-eval-nonliteral');
        if (EXECS.has(calleeName(node))) {
            const a = node.arguments[0];
            if (a && (a.type === 'BinaryExpression' || (a.type === 'TemplateLiteral' && a.expressions.length > 0))) hits.push('rs/no-child-process-concat');
        }
        if (SQL_CALLS.test(calleeName(node))) {
            const a = node.arguments[0];
            if (a && a.type === 'BinaryExpression' && a.operator === '+') {
                let sqlish = false;
                (function w(n) { if (!n) return; if (n.type === 'Literal' && typeof n.value === 'string' && looksSql(n.value)) sqlish = true; if (n.type === 'BinaryExpression') { w(n.left); w(n.right); } })(a);
                if (sqlish) hits.push('rs/no-sql-concat');
            }
        }
        if (objectName(node) === 'document' && /^(write|writeln)$/.test(calleeName(node))) hits.push('rs/no-document-write');
        if (calleeName(node) === 'createHash') {
            const a = node.arguments[0];
            if (a && a.type === 'Literal' && /^(md5|sha1)$/i.test(String(a.value))) hits.push('rs/no-weak-hash');
        }
    }

    if (t === 'NewExpression' && node.callee && node.callee.name === 'Function' && node.arguments.some(isNonLiteral)) {
        hits.push('rs/no-eval-nonliteral');
    }

    if (t === 'AssignmentExpression') {
        const left = node.left;
        if (left && left.type === 'MemberExpression' && left.property && /^(innerHTML|outerHTML)$/.test(left.property.name || '') && isNonLiteral(node.right)) {
            hits.push('rs/no-inner-html-nonliteral');
        }
        const nameNode = left && (left.property || left);
        const nm = nameNode && (nameNode.name || nameNode.value);
        if (nm && SECRET_RE.test(String(nm)) && isSecretLiteral(node.right)) hits.push('rs/no-hardcoded-secret');
    }

    if (t === 'VariableDeclarator' && node.id && SECRET_RE.test(String(node.id.name || '')) && isSecretLiteral(node.init)) hits.push('rs/no-hardcoded-secret');
    if (t === 'Property' && node.key && SECRET_RE.test(String(node.key.name || node.key.value || '')) && isSecretLiteral(node.value)) hits.push('rs/no-hardcoded-secret');

    if (t === 'BinaryExpression' && (node.operator === '==' || node.operator === '!=')) {
        // Flag non-strict equality. (=== null idiom is fine; == is the smell.)
        hits.push('rs/eqeqeq');
    }

    if ((t === 'IfStatement' || t === 'WhileStatement' || t === 'DoWhileStatement' || t === 'ConditionalExpression') && node.test && node.test.type === 'Literal') {
        hits.push('rs/no-constant-condition');
    }

    if (t === 'DebuggerStatement') hits.push('rs/no-debugger');

    if (t === 'CatchClause' && node.body && node.body.type === 'BlockStatement' && node.body.body.length === 0) hits.push('rs/no-empty-catch');

    return hits;
}

function isSecretLiteral(valueNode) {
    return valueNode && valueNode.type === 'Literal' && typeof valueNode.value === 'string'
        && valueNode.value.length >= 8 && !/^(process\.|env\.)/.test(valueNode.value);
}

// Generic full-tree walk (handles JSX and any node type without a per-type base).
function walkAll(node, visit, seen = new WeakSet()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    if (typeof node.type === 'string') visit(node);
    seen.add(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
        const val = node[key];
        if (Array.isArray(val)) { for (const c of val) walkAll(c, visit, seen); }
        else if (val && typeof val === 'object' && typeof val.type === 'string') walkAll(val, visit, seen);
    }
}

export class ASTLintEngine {
    constructor() { this._parser = null; }

    supports(language, filePath = '') {
        const lang = String(language || '').toLowerCase();
        if (lang === 'javascript' || lang === 'jsx') return true;
        if (!lang || lang === 'unknown') return /\.(js|jsx|mjs|cjs)$/i.test(filePath);
        return false;
    }

    /**
     * @param {string} code - full file source
     * @param {Object} context - { filePath, language }
     * @returns {Promise<{ ok:boolean, findings:Array, tool:string }>}
     */
    async analyze(code, context = {}) {
        const { filePath = 'unknown', language } = context;
        if (!code || !this.supports(language, filePath)) return { ok: false, findings: [], tool: 'ast-lint' };

        const Parser = await getParser();
        if (!Parser) return { ok: false, findings: [], tool: 'ast-lint' };

        let ast;
        try {
            ast = Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
        } catch {
            // partial/invalid source → fall back to regex
            return { ok: false, findings: [], tool: 'ast-lint' };
        }

        const lines = String(code).split('\n');
        const findings = [];
        const perRuleCount = {};
        walkAll(ast, (node) => {
            for (const ruleId of checkNode(node)) {
                perRuleCount[ruleId] = (perRuleCount[ruleId] || 0) + 1;
                if (perRuleCount[ruleId] > 20) continue; // cap runaway rules
                findings.push(this._toFinding(ruleId, node, filePath, lines));
            }
        });

        return { ok: true, findings, tool: 'ast-lint' };
    }

    _toFinding(ruleId, node, filePath, lines) {
        const meta = RULE_META[ruleId] || { severity: 'low', category: 'quality', cwe: null, message: ruleId };
        const line = node.loc ? node.loc.start.line : null;
        const snippet = line ? lines.slice(Math.max(0, line - 2), line + 1).join('\n') : '';
        return {
            ruleId,
            severity: meta.severity,
            category: meta.category,
            message: meta.message,
            line,
            column: node.loc ? node.loc.start.column + 1 : null,
            endLine: node.loc ? node.loc.end.line : line,
            codeSnippet: snippet,
            confidence: meta.category === 'security' ? 0.9 : 0.75,
            cwe: meta.cwe || null,
            filePath,
            tool: 'ast-lint',
            engine: 'acorn-ast'
        };
    }
}

// Back-compat alias — ESLintAnalyzer imports { ESLintEngine }.
export const ESLintEngine = ASTLintEngine;
export default ASTLintEngine;

/**
 * TreeSitterLintEngine — a REAL AST static analyzer for Python and Go.
 *
 * Parses source to a tree-sitter CST and matches defects with tree-sitter QUERIES
 * (structural), not regex. This closes the measured Python/Go gap where the regex
 * layer (JS-shaped patterns) missed `hashlib.md5`, `crypto/md5`, `os.system`, etc.
 *
 * Runtime-agnostic: it reuses an injected TreeSitterParser for grammar loading, so
 * the SAME engine runs in Node (tests + eval) and in the extension's offscreen
 * document (where tree-sitter's WASM runtime lives — the MV3 service worker can't
 * load WASM, so JS goes through the acorn engine and py/go route to offscreen).
 *
 * Every rule that fails to compile or throws is skipped, never fatal.
 */

const RULE_META = {
    // ── Python ──
    'py/weak-hash': { severity: 'medium', category: 'security', cwe: 'CWE-327', message: 'Weak hash (hashlib.md5/sha1) — use hashlib.sha256 or better.' },
    'py/os-system': { severity: 'high', category: 'security', cwe: 'CWE-78', message: 'os.system() runs a shell — use subprocess with an argument list; never interpolate input.' },
    'py/shell-true': { severity: 'high', category: 'security', cwe: 'CWE-78', message: 'subprocess called with shell=True — command injection risk if any argument is untrusted.' },
    'py/yaml-load': { severity: 'high', category: 'security', cwe: 'CWE-20', message: 'yaml.load() without SafeLoader can execute arbitrary objects — use yaml.safe_load().' },
    'py/pickle-loads': { severity: 'high', category: 'security', cwe: 'CWE-502', message: 'pickle.load/loads on untrusted data is arbitrary-code-execution — use a safe format.' },
    'py/eval-exec': { severity: 'critical', category: 'security', cwe: 'CWE-95', message: 'eval()/exec() on dynamic input is code injection.' },
    'py/hardcoded-secret': { severity: 'high', category: 'security', cwe: 'CWE-798', message: 'Possible hardcoded secret assigned to a secret-named variable.' },
    // ── Go ──
    'go/weak-hash': { severity: 'medium', category: 'security', cwe: 'CWE-327', message: 'Weak hash (crypto/md5 or crypto/sha1) — use sha256 or better.' },
    'go/exec-concat': { severity: 'critical', category: 'security', cwe: 'CWE-78', message: 'exec.Command built from a non-literal (concatenation) — command injection risk.' },
    'go/sql-sprintf': { severity: 'high', category: 'security', cwe: 'CWE-89', message: 'SQL built with fmt.Sprintf — use parameterized queries (placeholders), not string formatting.' },
    'go/insecure-tls': { severity: 'high', category: 'security', cwe: 'CWE-295', message: 'InsecureSkipVerify: true disables TLS certificate verification.' },
    'go/hardcoded-secret': { severity: 'high', category: 'security', cwe: 'CWE-798', message: 'Possible hardcoded secret assigned to a secret-named identifier.' },
    // ── TypeScript / TSX (real tree-sitter AST — the acorn engine handles plain JS) ──
    'ts/no-eval': { severity: 'critical', category: 'security', cwe: 'CWE-95', message: 'eval() with a non-literal argument — code injection risk.' },
    'ts/no-child-process-concat': { severity: 'critical', category: 'security', cwe: 'CWE-78', message: 'Shell command built from a non-literal (concatenation/template) — command injection risk.' },
    'ts/no-sql-concat': { severity: 'high', category: 'security', cwe: 'CWE-89', message: 'SQL built by concatenation with a variable — use parameterized queries.' },
    'ts/no-hardcoded-secret': { severity: 'high', category: 'security', cwe: 'CWE-798', message: 'Possible hardcoded secret assigned to a secret-named identifier.' },
    'ts/no-inner-html': { severity: 'high', category: 'security', cwe: 'CWE-79', message: 'innerHTML/outerHTML assigned a non-literal value — XSS risk. Sanitize or use textContent.' },
    'ts/no-document-write': { severity: 'medium', category: 'security', cwe: 'CWE-79', message: 'document.write() is an XSS sink; use safe DOM APIs.' },
    'ts/no-weak-hash': { severity: 'medium', category: 'security', cwe: 'CWE-327', message: 'Weak hash (md5/sha1) — use SHA-256 or better.' },
    'ts/eqeqeq': { severity: 'low', category: 'quality', cwe: null, message: 'Use === / !== instead of == / != to avoid type coercion bugs.' },
    'ts/no-debugger': { severity: 'medium', category: 'quality', cwe: null, message: 'debugger statement left in code.' },
    'ts/no-empty-catch': { severity: 'medium', category: 'bug', cwe: null, message: 'Empty catch block swallows the error silently.' },
    'ts/cors-wildcard': { severity: 'high', category: 'security', cwe: 'CWE-942', message: 'CORS origin set to "*" — permits any site to make credentialed cross-origin requests.' },
    'ts/debug-flag': { severity: 'medium', category: 'security', cwe: 'CWE-489', message: 'Debug flag hardcoded to true — do not ship debug mode enabled.' },
    'ts/json-parse-untrusted': { severity: 'high', category: 'security', cwe: 'CWE-502', message: 'JSON.parse() on request/untrusted input without validation — validate the parsed shape.' }
};

const SECRET_RE = /(secret|passwd|password|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|client[_-]?secret)/i;
const SQL_RE = /\b(select|insert|update|delete|where|from)\b/i;

function txt(n) { return n ? n.text : ''; }
function isSecretName(name) { return name && SECRET_RE.test(String(name)); }
function longString(node) {
    // python 'string' node text includes quotes; go interpreted_string_literal too.
    const raw = txt(node).replace(/^['"`]|['"`]$/g, '');
    return raw.length >= 8 && !/^(os\.|process\.|env|getenv)/i.test(raw);
}

// ── Python query set. Each { q, handle(map) -> ruleId|null, reportKey }. ──
const PY = [
    {
        q: '(call function: (attribute object: (identifier) @obj attribute: (identifier) @attr)) @call',
        report: 'call',
        handle: (m) => {
            const obj = txt(m.obj), attr = txt(m.attr);
            if (obj === 'hashlib' && /^(md5|sha1)$/.test(attr)) return 'py/weak-hash';
            if (obj === 'os' && attr === 'system') return 'py/os-system';
            if (obj === 'yaml' && attr === 'load') return 'py/yaml-load';
            if (obj === 'pickle' && /^(load|loads)$/.test(attr)) return 'py/pickle-loads';
            return null;
        }
    },
    {
        q: '(call function: (identifier) @fn) @call',
        report: 'call',
        handle: (m) => (/^(eval|exec)$/.test(txt(m.fn)) ? 'py/eval-exec' : null)
    },
    {
        q: '(keyword_argument name: (identifier) @k value: (true)) @kw',
        report: 'kw',
        handle: (m) => (txt(m.k) === 'shell' ? 'py/shell-true' : null)
    },
    {
        q: '(assignment left: (identifier) @name right: (string) @val) @a',
        report: 'a',
        handle: (m) => (isSecretName(txt(m.name)) && longString(m.val) ? 'py/hardcoded-secret' : null)
    }
];

// ── Go query set. ──
const GO = [
    {
        q: '(call_expression function: (selector_expression operand: (identifier) @pkg field: (field_identifier) @fn)) @call',
        report: 'call',
        handle: (m) => {
            const pkg = txt(m.pkg), fn = txt(m.fn);
            if (/^(md5|sha1)$/.test(pkg) && /^(New|Sum|New224|New384)$/.test(fn)) return 'go/weak-hash';
            if (pkg === 'exec' && fn === 'Command') return hasConcatArg(m.call) ? 'go/exec-concat' : null;
            if (pkg === 'fmt' && fn === 'Sprintf') return sprintfIsSql(m.call) ? 'go/sql-sprintf' : null;
            return null;
        }
    },
    {
        q: '(keyed_element (literal_element (identifier) @k) (literal_element (true))) @ke',
        report: 'ke',
        handle: (m) => (txt(m.k) === 'InsecureSkipVerify' ? 'go/insecure-tls' : null)
    },
    {
        q: '(const_spec name: (identifier) @name value: (expression_list (interpreted_string_literal) @val)) @s',
        report: 's',
        handle: (m) => (isSecretName(txt(m.name)) && longString(m.val) ? 'go/hardcoded-secret' : null)
    },
    {
        q: '(var_spec name: (identifier) @name value: (expression_list (interpreted_string_literal) @val)) @s',
        report: 's',
        handle: (m) => (isSecretName(txt(m.name)) && longString(m.val) ? 'go/hardcoded-secret' : null)
    }
];

function hasConcatArg(callNode) {
    const args = callNode.childForFieldName ? callNode.childForFieldName('arguments') : null;
    if (!args) return false;
    for (let i = 0; i < args.namedChildCount; i++) {
        const c = args.namedChild(i);
        if (c && c.type === 'binary_expression') return true;
    }
    return false;
}
function sprintfIsSql(callNode) {
    const args = callNode.childForFieldName ? callNode.childForFieldName('arguments') : null;
    if (!args) return false;
    for (let i = 0; i < args.namedChildCount; i++) {
        const c = args.namedChild(i);
        if (c && c.type === 'interpreted_string_literal' && SQL_RE.test(c.text)) return true;
    }
    return false;
}

// ── TypeScript / TSX helpers (tree-sitter-typescript node types) ──
const TS_LITERAL = new Set(['string', 'number', 'true', 'false', 'null', 'regex']);
function tsIsLiteral(n) { return !!n && TS_LITERAL.has(n.type); }
function tsHasSubstitution(node) {
    if (!node) return false;
    for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'template_substitution') return true;
    }
    return false;
}
function tsArgHasConcat(argsNode) {
    if (!argsNode) return false;
    for (let i = 0; i < argsNode.namedChildCount; i++) {
        const c = argsNode.namedChild(i);
        if (!c) continue;
        if (c.type === 'binary_expression') return true;
        if (c.type === 'template_string' && tsHasSubstitution(c)) return true;
    }
    return false;
}
function tsBinaryIsSql(node) {
    let sql = false;
    (function w(n) {
        if (!n) return;
        if (n.type === 'string' && SQL_RE.test(n.text)) sql = true;
        if (n.type === 'binary_expression') { w(n.childForFieldName('left')); w(n.childForFieldName('right')); }
    })(node);
    return sql;
}
function tsSecret(nameNode, valNode) {
    return (isSecretName(txt(nameNode)) && valNode && valNode.type === 'string' && longString(valNode)) ? true : false;
}
const UNTRUSTED_ROOT = /^(req|request|ctx|context|input|body|params|query)\b/i;
function tsArgUntrusted(argsNode) {
    const a = argsNode?.namedChild(0);
    if (!a) return false;
    if (a.type === 'member_expression') return UNTRUSTED_ROOT.test(a.text);
    if (a.type === 'identifier') return /^(body|input|payload|rawbody|raw)$/i.test(a.text);
    return false;
}
const isStarString = (n) => n && n.type === 'string' && /^["']\*["']$/.test(n.text);

const TS = [
    {
        q: '(call_expression function: (identifier) @fn arguments: (arguments) @args) @call',
        report: 'call',
        handle: (m) => {
            if (txt(m.fn) === 'eval') {
                const a = m.args?.namedChild(0);
                if (a && !tsIsLiteral(a)) return 'ts/no-eval';
            }
            return null;
        }
    },
    {
        q: '(call_expression function: (member_expression object: (_) @obj property: (property_identifier) @prop) arguments: (arguments) @args) @call',
        report: 'call',
        handle: (m) => {
            const obj = txt(m.obj), prop = txt(m.prop), args = m.args;
            if (obj === 'document' && /^(write|writeln)$/.test(prop)) return 'ts/no-document-write';
            if (prop === 'createHash') {
                const a = args?.namedChild(0);
                if (a && a.type === 'string' && /(md5|sha1)/i.test(txt(a))) return 'ts/no-weak-hash';
            }
            if (/^(exec|execSync|spawn|spawnSync|execFile)$/.test(prop) && tsArgHasConcat(args)) return 'ts/no-child-process-concat';
            if (/^(query|execute|exec|raw|prepare)$/i.test(prop)) {
                const a = args?.namedChild(0);
                if (a && a.type === 'binary_expression' && tsBinaryIsSql(a)) return 'ts/no-sql-concat';
            }
            if (obj === 'JSON' && prop === 'parse' && tsArgUntrusted(args)) return 'ts/json-parse-untrusted';
            return null;
        }
    },
    {
        q: '(pair key: (property_identifier) @k value: (string) @v) @pair',
        report: 'pair',
        handle: (m) => (txt(m.k) === 'origin' && isStarString(m.v) ? 'ts/cors-wildcard' : null)
    },
    {
        q: '(variable_declarator name: (identifier) @name value: (true)) @d',
        report: 'd',
        handle: (m) => (/^debug$/i.test(txt(m.name)) ? 'ts/debug-flag' : null)
    },
    {
        q: '(pair key: (property_identifier) @name value: (true)) @p',
        report: 'p',
        handle: (m) => (/^debug$/i.test(txt(m.name)) ? 'ts/debug-flag' : null)
    },
    {
        q: '(assignment_expression left: (member_expression property: (property_identifier) @prop) right: (_) @rhs) @assign',
        report: 'assign',
        handle: (m) => (/^(innerHTML|outerHTML)$/.test(txt(m.prop)) && !tsIsLiteral(m.rhs) ? 'ts/no-inner-html' : null)
    },
    { q: '(variable_declarator name: (identifier) @name value: (string) @val) @d', report: 'd', handle: (m) => (tsSecret(m.name, m.val) ? 'ts/no-hardcoded-secret' : null) },
    { q: '(pair key: (property_identifier) @name value: (string) @val) @p', report: 'p', handle: (m) => (tsSecret(m.name, m.val) ? 'ts/no-hardcoded-secret' : null) },
    { q: '(assignment_expression left: (identifier) @name right: (string) @val) @a', report: 'a', handle: (m) => (tsSecret(m.name, m.val) ? 'ts/no-hardcoded-secret' : null) },
    { q: '(binary_expression ["==" "!="] @op) @b', report: 'b', handle: () => 'ts/eqeqeq' },
    { q: '(debugger_statement) @d', report: 'd', handle: () => 'ts/no-debugger' },
    { q: '(catch_clause body: (statement_block) @body) @c', report: 'c', handle: (m) => (m.body && m.body.namedChildCount === 0 ? 'ts/no-empty-catch' : null) }
];

const QUERIES = { python: PY, go: GO, typescript: TS };

export class TreeSitterLintEngine {
    /** @param {Object} opts - { parser: TreeSitterParser } */
    constructor({ parser } = {}) {
        this.parser = parser;
    }

    supports(filePath) {
        const e = this.parser?.detect?.(filePath);
        return !!(e && QUERIES[e.lang]);
    }

    /**
     * @param {string} code
     * @param {Object} context - { filePath }
     * @returns {Promise<{ ok:boolean, findings:Array, tool:string }>}
     */
    async analyze(code, context = {}) {
        const { filePath = 'unknown' } = context;
        if (!code || !this.parser || !this.supports(filePath)) return { ok: false, findings: [], tool: 'tree-sitter-lint' };

        const entry = this.parser.detect(filePath);
        const ruleSet = QUERIES[entry.lang];

        let language, mod;
        try {
            language = await this.parser.loadLanguageForPath(filePath);
            mod = await this.parser.getModule();
        } catch { return { ok: false, findings: [], tool: 'tree-sitter-lint' }; }
        if (!language || !mod || !mod.Parser || !mod.Query) return { ok: false, findings: [], tool: 'tree-sitter-lint' };

        let tree;
        try {
            const p = new mod.Parser();
            p.setLanguage(language);
            tree = p.parse(code);
        } catch { return { ok: false, findings: [], tool: 'tree-sitter-lint' }; }
        if (!tree) return { ok: false, findings: [], tool: 'tree-sitter-lint' };

        const findings = [];
        const seen = new Set();
        for (const rule of ruleSet) {
            let query;
            try { query = new mod.Query(language, rule.q); } catch { continue; }
            let matches;
            try { matches = query.matches(tree.rootNode); } catch { continue; }
            for (const match of matches) {
                const map = {};
                for (const cap of match.captures) map[cap.name] = cap.node;
                const ruleId = rule.handle(map);
                if (!ruleId) continue;
                const node = map[rule.report] || match.captures[0]?.node;
                if (!node) continue;
                const line = node.startPosition.row + 1;
                const key = `${ruleId}:${line}`;
                if (seen.has(key)) continue;
                seen.add(key);
                findings.push(this._toFinding(ruleId, node, filePath, code));
            }
        }
        try { tree.delete?.(); } catch { /* ignore */ }
        return { ok: true, findings, tool: 'tree-sitter-lint' };
    }

    _toFinding(ruleId, node, filePath, code) {
        const meta = RULE_META[ruleId] || { severity: 'medium', category: 'security', cwe: null, message: ruleId };
        const line = node.startPosition.row + 1;
        const lines = String(code).split('\n');
        return {
            ruleId,
            severity: meta.severity,
            category: meta.category,
            message: meta.message,
            line,
            column: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            codeSnippet: lines.slice(Math.max(0, line - 2), line + 1).join('\n'),
            confidence: 0.85,
            cwe: meta.cwe || null,
            filePath,
            tool: 'tree-sitter-lint',
            engine: 'tree-sitter-ast'
        };
    }
}

export default TreeSitterLintEngine;

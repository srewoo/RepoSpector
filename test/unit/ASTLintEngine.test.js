/**
 * Tests for the real acorn-AST static engine (ESLintEngine.js).
 * Runs the actual parser + AST visitors — no mocks, no network.
 */
const { ASTLintEngine, ESLintEngine } = require('../../src/services/ESLintEngine.js');

const engine = new ASTLintEngine();

async function rulesFor(code, ctx = { filePath: 'a.js', language: 'javascript' }) {
    const r = await engine.analyze(code, ctx);
    return { ok: r.ok, rules: r.findings.map(f => f.ruleId), findings: r.findings };
}

describe('ASTLintEngine (real acorn AST)', () => {
    it('exports ESLintEngine as an alias', () => {
        expect(ESLintEngine).toBe(ASTLintEngine);
    });

    it('flags eval() with a non-literal argument, not with a literal', async () => {
        const bad = await rulesFor('eval(userInput);');
        expect(bad.rules).toContain('rs/no-eval-nonliteral');
        const good = await rulesFor('eval("1 + 1");');
        expect(good.rules).not.toContain('rs/no-eval-nonliteral');
    });

    it('flags shell exec built by concatenation/template', async () => {
        const bad = await rulesFor('cp.exec("ls " + dir);');
        expect(bad.rules).toContain('rs/no-child-process-concat');
        const tmpl = await rulesFor('cp.execSync(`rm ${path}`);');
        expect(tmpl.rules).toContain('rs/no-child-process-concat');
        const good = await rulesFor('cp.exec("ls -la");');
        expect(good.rules).not.toContain('rs/no-child-process-concat');
    });

    it('flags SQL string concatenation but not a benign concat', async () => {
        const bad = await rulesFor('db.query("SELECT * FROM t WHERE id = " + id);');
        expect(bad.rules).toContain('rs/no-sql-concat');
        const good = await rulesFor('logger.info("Hello, " + name);');
        expect(good.rules).not.toContain('rs/no-sql-concat');
    });

    it('flags a hardcoded secret literal, not an env reference', async () => {
        const bad = await rulesFor('const apiKey = "sk-livesecret123";');
        expect(bad.rules).toContain('rs/no-hardcoded-secret');
        const good = await rulesFor('const apiKey = process.env.API_KEY;');
        expect(good.rules).not.toContain('rs/no-hardcoded-secret');
    });

    it('flags innerHTML with a non-literal and document.write', async () => {
        const bad = await rulesFor('el.innerHTML = userHtml; document.write(x);');
        expect(bad.rules).toContain('rs/no-inner-html-nonliteral');
        expect(bad.rules).toContain('rs/no-document-write');
        const good = await rulesFor('el.innerHTML = "<b>static</b>";');
        expect(good.rules).not.toContain('rs/no-inner-html-nonliteral');
    });

    it('flags weak hashes', async () => {
        expect((await rulesFor('crypto.createHash("md5");')).rules).toContain('rs/no-weak-hash');
        expect((await rulesFor('crypto.createHash("sha256");')).rules).not.toContain('rs/no-weak-hash');
    });

    it('flags == / != , constant conditions, debugger, and empty catch', async () => {
        expect((await rulesFor('if (x == 1) {}')).rules).toContain('rs/eqeqeq');
        expect((await rulesFor('while (true) { break; }')).rules).toContain('rs/no-constant-condition');
        expect((await rulesFor('debugger;')).rules).toContain('rs/no-debugger');
        expect((await rulesFor('try { go(); } catch (e) {}')).rules).toContain('rs/no-empty-catch');
    });

    it('parses JSX and finds issues inside expressions', async () => {
        const code = 'function C(){ const h = user; return <div dangerouslySetInnerHTML={{__html: eval(h)}} />; }';
        const r = await rulesFor(code, { filePath: 'C.jsx', language: 'jsx' });
        expect(r.ok).toBe(true);
        expect(r.rules).toContain('rs/no-eval-nonliteral');
    });

    it('does not support TypeScript (caller falls back to regex)', async () => {
        expect(engine.supports('typescript', 'a.ts')).toBe(false);
        const r = await engine.analyze('const x: number = 1;', { filePath: 'a.ts', language: 'typescript' });
        expect(r.ok).toBe(false);
    });

    it('returns ok:false on unparseable partial hunks', async () => {
        const r = await engine.analyze('} else { broken(', { filePath: 'a.js', language: 'javascript' });
        expect(r.ok).toBe(false);
        expect(r.findings).toEqual([]);
    });

    it('attaches CWE + line to security findings', async () => {
        const r = await engine.analyze('\n\neval(x);', { filePath: 'a.js', language: 'javascript' });
        const evalFinding = r.findings.find(f => f.ruleId === 'rs/no-eval-nonliteral');
        expect(evalFinding.cwe).toBe('CWE-95');
        expect(evalFinding.line).toBe(3);
        expect(evalFinding.severity).toBe('critical');
    });
});

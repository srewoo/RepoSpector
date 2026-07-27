/**
 * Tests for the real Python/Go tree-sitter AST lint engine.
 * Loads actual grammar wasm from node_modules and parses for real — no mocks.
 */
const fs = require('fs');
const path = require('path');
const { TreeSitterParser } = require('../../src/services/TreeSitterParser.js');
const { TreeSitterLintEngine } = require('../../src/services/TreeSitterLintEngine.js');

const RUNTIME_WASM = path.resolve('node_modules/web-tree-sitter/tree-sitter.wasm');
const GRAMMAR_DIR = path.resolve('node_modules/tree-sitter-wasms/out');

async function makeEngine() {
    const mod = require('web-tree-sitter');
    const parser = new TreeSitterParser({
        module: mod,
        runtimeLocator: () => RUNTIME_WASM,
        grammarLoader: async (g) => new Uint8Array(fs.readFileSync(path.join(GRAMMAR_DIR, `tree-sitter-${g}.wasm`)))
    });
    return new TreeSitterLintEngine({ parser });
}

let engine;
beforeAll(async () => { engine = await makeEngine(); }, 30000);

async function rules(code, filePath) {
    const r = await engine.analyze(code, { filePath });
    return { ok: r.ok, ids: r.findings.map(f => f.ruleId), findings: r.findings };
}

describe('TreeSitterLintEngine — Python', () => {
    it('flags hashlib.md5/sha1 (the gap the regex layer missed)', async () => {
        const r = await rules('import hashlib\nh = hashlib.md5(data)\n', 'a.py');
        expect(r.ok).toBe(true);
        expect(r.ids).toContain('py/weak-hash');
        const clean = await rules('import hashlib\nh = hashlib.sha256(data)\n', 'a.py');
        expect(clean.ids).not.toContain('py/weak-hash');
    });

    it('flags os.system, yaml.load, pickle.loads, eval/exec', async () => {
        expect((await rules('import os\nos.system("rm " + x)\n', 'a.py')).ids).toContain('py/os-system');
        expect((await rules('import yaml\nyaml.load(s)\n', 'a.py')).ids).toContain('py/yaml-load');
        expect((await rules('import pickle\npickle.loads(b)\n', 'a.py')).ids).toContain('py/pickle-loads');
        expect((await rules('eval(user_input)\n', 'a.py')).ids).toContain('py/eval-exec');
    });

    it('flags subprocess shell=True', async () => {
        const r = await rules('import subprocess\nsubprocess.run(cmd, shell=True)\n', 'a.py');
        expect(r.ids).toContain('py/shell-true');
    });

    it('flags a hardcoded secret, not an env lookup', async () => {
        expect((await rules('api_key = "sk-livesecret123"\n', 'a.py')).ids).toContain('py/hardcoded-secret');
        expect((await rules('import os\napi_key = os.getenv("API_KEY")\n', 'a.py')).ids).not.toContain('py/hardcoded-secret');
    });

    it('is clean on benign Python', async () => {
        const r = await rules('def add(a, b):\n    return a + b\n', 'a.py');
        expect(r.ok).toBe(true);
        expect(r.findings).toHaveLength(0);
    });
});

describe('TreeSitterLintEngine — Go', () => {
    it('flags crypto/md5 usage', async () => {
        const r = await rules('package m\nimport "crypto/md5"\nfunc h(b []byte) { md5.Sum(b) }\n', 'a.go');
        expect(r.ok).toBe(true);
        expect(r.ids).toContain('go/weak-hash');
    });

    it('flags exec.Command with concatenation, not with a literal', async () => {
        const bad = await rules('package m\nimport "os/exec"\nfunc r(x string) { exec.Command("sh", "-c", "ls "+x) }\n', 'a.go');
        expect(bad.ids).toContain('go/exec-concat');
        const good = await rules('package m\nimport "os/exec"\nfunc r() { exec.Command("ls", "-la") }\n', 'a.go');
        expect(good.ids).not.toContain('go/exec-concat');
    });

    it('flags SQL built with fmt.Sprintf', async () => {
        const r = await rules('package m\nimport "fmt"\nfunc q(id string) string { return fmt.Sprintf("SELECT * FROM t WHERE id=%s", id) }\n', 'a.go');
        expect(r.ids).toContain('go/sql-sprintf');
    });

    it('flags InsecureSkipVerify: true', async () => {
        const r = await rules('package m\nimport "crypto/tls"\nvar c = &tls.Config{InsecureSkipVerify: true}\n', 'a.go');
        expect(r.ids).toContain('go/insecure-tls');
    });

    it('flags a hardcoded secret const/var', async () => {
        expect((await rules('package m\nconst apiKey = "sk-livesecret123"\n', 'a.go')).ids).toContain('go/hardcoded-secret');
    });

    it('is clean on benign Go', async () => {
        const r = await rules('package m\nfunc Add(a, b int) int { return a + b }\n', 'a.go');
        expect(r.ok).toBe(true);
        expect(r.findings).toHaveLength(0);
    });
});

describe('TreeSitterLintEngine — TypeScript', () => {
    it('flags eval with a non-literal, not a literal (typed code)', async () => {
        const bad = await rules('const x: string = userInput;\neval(x);\n', 'a.ts');
        expect(bad.ok).toBe(true);
        expect(bad.ids).toContain('ts/no-eval');
        const good = await rules('eval("1 + 1");\n', 'a.ts');
        expect(good.ids).not.toContain('ts/no-eval');
    });

    it('flags exec concat, SQL concat, weak hash, document.write', async () => {
        expect((await rules('cp.exec("ls " + dir);', 'a.ts')).ids).toContain('ts/no-child-process-concat');
        expect((await rules('db.query("SELECT * FROM t WHERE id=" + id);', 'a.ts')).ids).toContain('ts/no-sql-concat');
        expect((await rules('crypto.createHash("md5");', 'a.ts')).ids).toContain('ts/no-weak-hash');
        expect((await rules('document.write(foo);', 'a.ts')).ids).toContain('ts/no-document-write');
    });

    it('flags innerHTML non-literal and hardcoded secret', async () => {
        expect((await rules('el.innerHTML = userHtml;', 'a.ts')).ids).toContain('ts/no-inner-html');
        expect((await rules('const apiKey: string = "sk-livesecret123";', 'a.ts')).ids).toContain('ts/no-hardcoded-secret');
        expect((await rules('const apiKey = process.env.API_KEY;', 'a.ts')).ids).not.toContain('ts/no-hardcoded-secret');
    });

    it('flags ==, debugger, empty catch', async () => {
        expect((await rules('if (x == 1) {}', 'a.ts')).ids).toContain('ts/eqeqeq');
        expect((await rules('debugger;', 'a.ts')).ids).toContain('ts/no-debugger');
        expect((await rules('try { go(); } catch (e) {}', 'a.ts')).ids).toContain('ts/no-empty-catch');
    });

    it('parses TSX and finds an issue inside a component', async () => {
        const code = 'function C(){ const h = user; return <div dangerouslySetInnerHTML={{__html: h}}>{eval(h)}</div>; }';
        const r = await rules(code, 'C.tsx');
        expect(r.ok).toBe(true);
        expect(r.ids).toContain('ts/no-eval');
    });

    it('flags the semantic misconfig/integrity patterns', async () => {
        expect((await rules('app.use(cors({ origin: "*" }));', 'a.ts')).ids).toContain('ts/cors-wildcard');
        expect((await rules('const DEBUG = true;', 'a.ts')).ids).toContain('ts/debug-flag');
        expect((await rules('const obj = JSON.parse(req.body);', 'a.ts')).ids).toContain('ts/json-parse-untrusted');
    });

    it('does NOT flag benign versions of the semantic patterns', async () => {
        expect((await rules('app.use(cors({ origin: "https://app.acme.com" }));', 'a.ts')).ids).not.toContain('ts/cors-wildcard');
        expect((await rules('const VERBOSE = true;', 'a.ts')).ids).not.toContain('ts/debug-flag');
        expect((await rules('const cfg = JSON.parse(localFileContents);', 'a.ts')).ids).not.toContain('ts/json-parse-untrusted');
    });

    it('is clean on benign typed TypeScript', async () => {
        const r = await rules('function add(a: number, b: number): number {\n  return a + b;\n}\n', 'a.ts');
        expect(r.ok).toBe(true);
        expect(r.findings).toHaveLength(0);
    });
});

describe('TreeSitterLintEngine — scope', () => {
    it('does not support JS (handled by the acorn engine)', async () => {
        expect(engine.supports('a.js')).toBe(false);
        const r = await engine.analyze('eval(x)', { filePath: 'a.js' });
        expect(r.ok).toBe(false);
    });
    it('does support TypeScript now', () => {
        expect(engine.supports('a.ts')).toBe(true);
        expect(engine.supports('a.tsx')).toBe(true);
    });
});

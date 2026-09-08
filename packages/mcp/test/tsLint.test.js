import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintTypeScript } from '../src/tools/tsLint.js';

const TIMEOUT = 120000;

/**
 * AST linting for TypeScript, which the MCP path had none of.
 *
 * `ASTLintEngine.supports` accepts only `.js/.jsx/.mjs/.cjs`, so every `.ts`
 * file fell through to the regex rules: a measured review reported
 * `engines: {regex: 15}` — no parsed analysis at all — with six findings
 * withheld as mis-mapped and eleven false criticals from one loose pattern.
 *
 * `TreeSitterLintEngine` already carries TypeScript queries and was wired only
 * into the extension's offscreen document. Nothing about it is
 * browser-specific: it needs a `TreeSitterParser`, and this package builds one
 * for the graph already.
 */

test('parses a .ts file and reports a real finding', { timeout: TIMEOUT }, async () => {
    const files = [{
        path: 'src/thing.ts',
        content: 'export function cmp(a: string, b: string): boolean {\n'
            + '  return a == b;\n'
            + '}\n',
    }];

    const { findings } = await lintTypeScript(files);

    const eq = findings.find((f) => f.ruleId === 'ts/eqeqeq');
    assert.ok(eq, `no ts/eqeqeq finding: ${JSON.stringify(findings)}`);
    assert.equal(eq.line, 2);
    assert.equal(eq.filePath, 'src/thing.ts');
});

test('labels its findings as tree-sitter, not as a linter it is not', { timeout: TIMEOUT }, async () => {
    const files = [{
        path: 'src/thing.ts',
        content: 'export const same = (a: number, b: number) => a == b;\n',
    }];

    const { findings } = await lintTypeScript(files);

    assert.ok(findings.length > 0);
    for (const f of findings) {
        assert.equal(f.engine, 'tree-sitter');
        assert.equal(f.tool, 'tree-sitter-lint');
    }
});

test('finds an empty catch that a regex rule also claims, so the two can corroborate', { timeout: TIMEOUT }, async () => {
    const files = [{
        path: 'src/thing.ts',
        content: 'export async function go(): Promise<void> {\n'
            + '  try {\n    await work();\n  } catch (e) {}\n'
            + '}\n',
    }];

    const { findings } = await lintTypeScript(files);

    assert.ok(
        findings.some((f) => f.ruleId === 'ts/no-empty-catch'),
        `no empty-catch finding: ${JSON.stringify(findings)}`,
    );
});

test('clean TypeScript yields nothing', { timeout: TIMEOUT }, async () => {
    const files = [{
        path: 'src/clean.ts',
        content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    }];

    const { findings } = await lintTypeScript(files);
    assert.deepEqual(findings, []);
});

test('a .js file is left to the acorn engine', { timeout: TIMEOUT }, async () => {
    const files = [{ path: 'src/thing.js', content: 'const x = 1 == 2;\n' }];
    const { findings, filesParsed } = await lintTypeScript(files);
    assert.deepEqual(findings, []);
    assert.equal(filesParsed, 0, 'claimed to have parsed a file it does not handle');
});

test('unparseable content fails soft rather than failing the section', { timeout: TIMEOUT }, async () => {
    const files = [{ path: 'src/broken.ts', content: 'export function ((((\n' }];
    const { findings } = await lintTypeScript(files);
    assert.ok(Array.isArray(findings));
});

test('a file with no content is skipped', { timeout: TIMEOUT }, async () => {
    const { findings, filesParsed } = await lintTypeScript([{ path: 'src/empty.ts', content: '' }]);
    assert.deepEqual(findings, []);
    assert.equal(filesParsed, 0);
});

test('reports how many files it PARSED, so a clean pass is distinguishable from no pass', { timeout: TIMEOUT }, async () => {
    // Measured on the real merge request: the engine parsed three real
    // TypeScript files (9KB, 19KB, 68KB) with `ok: true` and found nothing —
    // a true negative. But the bundle's engine histogram read `{regex: 15}`,
    // with no mention of tree-sitter, so a reader could not tell the AST pass
    // had run at all. Silence reading as a pass is the defect this whole
    // effort exists to remove.
    const files = [
        { path: 'src/clean-a.ts', content: 'export const a = (x: number): number => x + 1;\n' },
        { path: 'src/clean-b.ts', content: 'export class B { go(): void {} }\n' },
        { path: 'src/notes.md', content: '# not typescript\n' },
    ];

    const { findings, filesParsed } = await lintTypeScript(files);

    assert.deepEqual(findings, []);
    assert.equal(filesParsed, 2, 'a clean AST pass over two files must still be reported');
});

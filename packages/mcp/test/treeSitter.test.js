import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeParser } from '../src/adapters/treeSitter.js';

const JS = `
export function alpha(x) { return beta(x) + 1; }
function beta(y) { return y * 2; }
export class Widget extends Base { render() { return alpha(1); } }
`;

test('parses real JavaScript into the same shape the regex path produces', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([{ path: 'a.js', content: JS }]);

    assert.ok(analyses instanceof Map, 'expected a Map of path → analysis');
    const a = analyses.get('a.js');
    assert.ok(a, 'no analysis for a.js');

    const names = a.symbols.map((s) => s.name);
    assert.ok(names.includes('alpha'), `alpha missing from ${names.join(', ')}`);
    assert.ok(names.includes('beta'));
    assert.ok(names.includes('Widget'));

    // Shape contract, quoted from TreeSitterParser's docstring: the tree-sitter
    // output must match the regex path exactly, or downstream graph consumers
    // silently see different fields depending on which path ran.
    for (const s of a.symbols) {
        assert.equal(typeof s.name, 'string');
        assert.equal(typeof s.startLine, 'number');
        assert.equal(typeof s.endLine, 'number');
    }
});

test('resolves calls, which is the whole reason for using an AST', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([{ path: 'a.js', content: JS }]);
    const calls = (analyses.get('a.js').calls || []).map((c) => c.name);
    assert.ok(calls.includes('beta'), `expected a call to beta, got ${calls.join(', ')}`);
});

test('parses Python too, proving grammars load from node_modules', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([
        { path: 'm.py', content: 'def gamma(a):\n    return delta(a)\n\ndef delta(b):\n    return b\n' },
    ]);
    const names = (analyses.get('m.py').symbols || []).map((s) => s.name);
    assert.ok(names.includes('gamma'), `gamma missing from ${names.join(', ')}`);
});

test('an unsupported extension is skipped rather than failing the batch', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([
        { path: 'notes.txt', content: 'plain text' },
        { path: 'a.js', content: JS },
    ]);
    assert.equal(analyses.has('notes.txt'), false);
    assert.ok(analyses.has('a.js'), 'a supported file must still be analysed');
});

test('an empty file list returns an empty Map, never null', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([]);
    assert.ok(analyses instanceof Map);
    assert.equal(analyses.size, 0);
});

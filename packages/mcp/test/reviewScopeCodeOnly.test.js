import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touchedSymbolContext } from '../src/tools/reviewScope.js';

/**
 * `codeOnly()` used to strip string literals BEFORE line comments. An
 * apostrophe inside a `//` comment therefore opened a phantom string that ran
 * to the next quote anywhere in the file, deleting the code between.
 *
 * Reproduced against ky at e68ea7ad: `source/core/Ky.ts` went from 41,382
 * characters to 13,687, taking `const validateJsonWithSchema = ...` with it.
 * `declares()` then could not see a symbol plainly still in the file, so
 * `touchedSymbolContext` put it in `removed` — `review_pr` reported a surviving
 * function as deleted and `surviving_references` agreed nothing referenced it.
 *
 * The change under review had itself added the comment
 *   // Awaiting here preserves the caller's async stack when validation fails.
 * so the apostrophe that broke the analysis arrived in the very diff being
 * analysed.
 *
 * Swapping the order is not the fix: `Ky.ts:49` holds a URL inside a string
 * literal, and stripping comments first would blank the rest of that line. The
 * `//-in-a-string` case below guards that direction.
 */

/** Minimal stand-in for KnowledgeGraphService's readers. */
function graphWith(nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        getNode: (id) => byId.get(id) || null,
        getNodesByFile: (path) => nodes.filter((n) => n.properties.filePath === path),
        getRelationshipsTo: () => [],
        getRelationshipsFrom: () => [],
        relationships: new Map(),
    };
}

const FILE = 'source/core/Ky.ts';

const symbolNode = (name) => ({
    id: `n:${name}`,
    label: 'Function',
    properties: { name, filePath: FILE },
});

// The real shape: the diff DELETES a line naming the symbol (the ternary that
// used to call it) and ADDS a comment containing an apostrophe plus a new call.
// The declaration itself sits outside the hunk.
const PATCH = [
    '@@ -331,7 +331,12 @@',
    '-\t\t\t\t\treturn schema === undefined ? jsonValue : validateJsonWithSchema(jsonValue, schema);',
    '+\t\t\t\t\tif (schema === undefined) {',
    '+\t\t\t\t\t\treturn jsonValue;',
    '+\t\t\t\t\t}',
    '+',
    "+\t\t\t\t\t// Awaiting here preserves the caller's async stack when validation fails.",
    '+\t\t\t\t\treturn await validateJsonWithSchema(jsonValue, schema);',
].join('\n');

const run = (headText) => touchedSymbolContext(
    graphWith([symbolNode('validateJsonWithSchema')]),
    [{ filename: FILE, patch: PATCH }],
    { headContentByPath: new Map([[FILE, headText]]) },
);

const removedNames = (ctx) => ctx.removed.map((r) => r.name);

test('a symbol the head revision still declares is not reported removed', () => {
    // The hazard: an apostrophe in a comment ABOVE the declaration. Under the
    // old implementation everything from it to the next quote was deleted.
    const head = [
        "// Shallow-clone options so init hook mutations don't leak across requests.",
        'const validateJsonWithSchema = async (jsonValue, schema) => {',
        '\treturn schema.validate(jsonValue);',
        '};',
        "const other = 'x';",
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), []);
});

test('a symbol the head revision genuinely dropped is still reported removed', () => {
    const head = [
        "// Shallow-clone options so init hook mutations don't leak across requests.",
        "const other = 'x';",
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), ['validateJsonWithSchema']);
});

test('a `//` inside a string does not blank the code after it', () => {
    // The inverse hazard, which stripping comments first would introduce.
    const head = [
        "const docs = 'https://example.com/guide#anchor';",
        'const validateJsonWithSchema = async (jsonValue, schema) => schema;',
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), []);
});

test('a stray apostrophe in code does not swallow the rest of the file', () => {
    // An unterminated `'` cannot span a newline, so the scanner bails at the
    // line end instead of eating everything up to the next quote.
    const head = [
        "const s = 'unterminated",
        'const validateJsonWithSchema = async (jsonValue, schema) => schema;',
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), []);
});

test('a multi-line template literal does not hide a later declaration', () => {
    const head = [
        'const banner = `line one',
        'line two`;',
        'const validateJsonWithSchema = async (jsonValue, schema) => schema;',
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), []);
});

test('a declaration inside a block comment does not count as a declaration', () => {
    const head = [
        '/*',
        'const validateJsonWithSchema = async (jsonValue, schema) => schema;',
        '*/',
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), ['validateJsonWithSchema']);
});

test('an escaped quote does not terminate the string early', () => {
    const head = [
        "const s = 'it\\'s fine';",
        'const validateJsonWithSchema = async (jsonValue, schema) => schema;',
    ].join('\n');
    assert.deepEqual(removedNames(run(head)), []);
});

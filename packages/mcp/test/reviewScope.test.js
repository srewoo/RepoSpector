import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touchedSymbolContext, coverageForDiff } from '../src/tools/reviewScope.js';

/**
 * The two sections that answered a question nobody asked.
 *
 * `graph_context` returned `pipeline.getStats()` — repo-wide node and edge
 * counts — while the rubric promises "callers and callees of the touched
 * symbols". `covering_tests` returned a whole-graph aggregate: on a real review
 * that was `coverageRatio: 0.04` over 360 test files, true and useless, and
 * silent about the five test files that merge request DELETES.
 *
 * For a deletion-heavy change the only questions that matter are "who still
 * calls the symbol you removed" and "what coverage goes with it", and neither
 * section could express either.
 */

/** A hand-built graph, so these assertions do not depend on a real index. */
function graphOf({ nodes, rels }) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        getNode: (id) => byId.get(id),
        getNodesByFile: (filePath) => nodes.filter((n) => n.properties?.filePath === filePath),
        findNodeByName: (name) => nodes.find((n) => n.properties?.name === name) || null,
        getRelationshipsTo: (id) => rels.filter((r) => r.targetId === id),
        getRelationshipsFrom: (id) => rels.filter((r) => r.sourceId === id),
    };
}

const SAMPLE = graphOf({
    nodes: [
        { id: 'f1', label: 'File', properties: { filePath: 'src/store.js' } },
        { id: 'n1', label: 'Method', properties: { name: 'findSimilar', filePath: 'src/store.js' } },
        { id: 'n2', label: 'Function', properties: { name: 'gatherContext', filePath: 'src/ctx.js' } },
        { id: 'n3', label: 'Function', properties: { name: 'embedText', filePath: 'src/embed.js' } },
        { id: 't1', label: 'Function', properties: { name: 'storeSpec', filePath: 'test/store.test.js' } },
    ],
    rels: [
        { type: 'CALLS', sourceId: 'n2', targetId: 'n1' },   // gatherContext -> findSimilar
        { type: 'CALLS', sourceId: 'n1', targetId: 'n3' },   // findSimilar -> embedText
        { type: 'TESTED_BY', sourceId: 'n1', targetId: 't1' },
    ],
});

test('names the callers of a symbol the change touches', () => {
    const out = touchedSymbolContext(SAMPLE, [{ filename: 'src/store.js', patch: '' }]);

    const symbol = out.symbols.find((s) => s.name === 'findSimilar');
    assert.ok(symbol, 'the touched symbol is absent from graph context');
    assert.deepEqual(symbol.calledBy, ['gatherContext']);
});

test('names the callees of a symbol the change touches', () => {
    const out = touchedSymbolContext(SAMPLE, [{ filename: 'src/store.js', patch: '' }]);

    const symbol = out.symbols.find((s) => s.name === 'findSimilar');
    assert.deepEqual(symbol.calls, ['embedText']);
});

test('a symbol REMOVED by the change is reported with its surviving callers', () => {
    // The question a deletion review lives on: the diff deletes `findSimilar`,
    // and `gatherContext` still calls it.
    const diffFiles = [{
        filename: 'src/store.js',
        patch: [
            '@@ -1,4 +1,1 @@',
            '-  async findSimilar(query) {',
            '-    return this.collection.query(query);',
            '-  }',
            ' const keep = 1;',
        ].join('\n'),
    }];

    const out = touchedSymbolContext(SAMPLE, diffFiles);

    const removed = out.removed.find((s) => s.name === 'findSimilar');
    assert.ok(removed, 'a deleted symbol is not called out at all');
    assert.deepEqual(removed.calledBy, ['gatherContext']);
});

test('carries graph totals as provenance, not as the answer', () => {
    const out = touchedSymbolContext(SAMPLE, [{ filename: 'src/store.js', patch: '' }]);
    assert.ok(out.symbols, 'no per-symbol section');
    assert.equal(typeof out.graph, 'object');
});

test('a file the graph knows nothing about is named rather than omitted', () => {
    const out = touchedSymbolContext(SAMPLE, [{ filename: 'src/brand-new.js', patch: '' }]);
    assert.deepEqual(out.filesWithoutSymbols, ['src/brand-new.js']);
});

test('reports the tests covering a touched symbol', () => {
    const out = coverageForDiff(SAMPLE, [{ filename: 'src/store.js', patch: '' }]);

    const covered = out.covered.find((c) => c.symbol === 'findSimilar');
    assert.ok(covered, 'no coverage reported for the touched symbol');
    assert.deepEqual(covered.tests, ['test/store.test.js']);
});

test('reports a touched symbol that no test covers', () => {
    const out = coverageForDiff(SAMPLE, [{ filename: 'src/ctx.js', patch: '' }]);
    assert.deepEqual(out.untested, ['gatherContext']);
});

test('names test files the change DELETES', () => {
    // Five deleted test files (26 tests) was the highest-risk part of the real
    // merge request, and the bundle never mentioned them.
    const diffFiles = [
        { filename: 'test/store.test.js', patch: '@@ -1,3 +0,0 @@\n-it("x", () => {});\n-\n-', status: 'removed' },
        { filename: 'src/store.js', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
    ];

    const out = coverageForDiff(SAMPLE, diffFiles);

    assert.deepEqual(out.testFilesDeleted, ['test/store.test.js']);
});

test('a deleted test file is detected from an all-deletions patch too', () => {
    // `status` is absent for ordinary entries produced by `parseUnifiedDiff`,
    // so the patch itself has to be enough.
    const diffFiles = [
        { filename: 'test/store.test.js', patch: '@@ -1,2 +0,0 @@\n-it("x", () => {});\n-' },
    ];

    const out = coverageForDiff(SAMPLE, diffFiles);

    assert.deepEqual(out.testFilesDeleted, ['test/store.test.js']);
});

test('a test file that is only MODIFIED is not reported as deleted', () => {
    const diffFiles = [
        { filename: 'test/store.test.js', patch: '@@ -1,2 +1,2 @@\n-it("x", () => {});\n+it("y", () => {});' },
    ];

    const out = coverageForDiff(SAMPLE, diffFiles);

    assert.deepEqual(out.testFilesDeleted, []);
    assert.deepEqual(out.testFilesChanged, ['test/store.test.js']);
});

/**
 * How the symbol budget is spent.
 *
 * Found by re-reviewing the original merge request with everything else fixed:
 * `graph_context` hit its 60-symbol cap walking files in git order and stopped
 * BEFORE `packages/vector-store/src/vector-store.service.ts` and
 * `packages/epic-processing/src/epic-processing.service.ts` — the two files
 * whose deletions the review was actually about. It spent the cap on 19 symbols
 * of `tool-handlers-merged.ts`. Exactly the failure the hunks budget had: a
 * first-come cap in alphabetical order.
 */

const WIDE = graphOf({
    nodes: [
        { id: 'fa', label: 'File', properties: { filePath: 'a/first.js' } },
        ...Array.from({ length: 30 }, (_unused, i) => ({
            id: `a${i}`,
            label: 'Function',
            properties: { name: `first${i}`, filePath: 'a/first.js' },
        })),
        ...Array.from({ length: 30 }, (_unused, i) => ({
            id: `z${i}`,
            label: 'Function',
            properties: { name: `last${i}`, filePath: 'z/last.js' },
        })),
    ],
    rels: [],
});

const bigPatch = (names) => [
    `@@ -1,${names.length} +1,1 @@`,
    ...names.map((n) => `-  function ${n}() {}`),
    '+const kept = 1;',
].join('\n');

test('a later file is not starved of the symbol budget by an earlier one', () => {
    const out = touchedSymbolContext(
        WIDE,
        [
            { filename: 'a/first.js', patch: bigPatch(['first0', 'first1']) },
            { filename: 'z/last.js', patch: bigPatch(['last0', 'last1']) },
        ],
        { maxSymbols: 20 },
    );

    const files = new Set(out.symbols.map((s) => s.file));
    assert.ok(
        files.has('z/last.js'),
        `the second file got nothing: ${[...files].join(', ')}`,
    );
    assert.ok(files.has('a/first.js'));
});

test('symbols the change removes are reported even under a tight budget', () => {
    const out = touchedSymbolContext(
        WIDE,
        [
            { filename: 'a/first.js', patch: bigPatch(Array.from({ length: 30 }, (_u, i) => `first${i}`)) },
            { filename: 'z/last.js', patch: bigPatch(['last7']) },
        ],
        { maxSymbols: 6 },
    );

    assert.ok(
        out.removed.some((r) => r.name === 'last7'),
        'a removed symbol in the last file was dropped for budget',
    );
});

test('says when the symbol list was capped', () => {
    const out = touchedSymbolContext(
        WIDE,
        [{ filename: 'a/first.js', patch: bigPatch(['first0']) }],
        { maxSymbols: 5 },
    );

    assert.equal(out.truncated, true);
    assert.match(out.truncatedNote || '', /cap|not shown|maxSymbols/i);
});

test('an uncapped list says nothing about truncation', () => {
    const out = touchedSymbolContext(
        SAMPLE,
        [{ filename: 'src/store.js', patch: '' }],
        { maxSymbols: 100 },
    );

    assert.equal(out.truncated, undefined);
    assert.equal(out.truncatedNote, undefined);
});

/**
 * Two ways `removed` missed the symbols the review was about.
 *
 * Re-reviewing the original merge request: `findSimilar`, `addTestCases`,
 * `buildContext` and `findSimilarBatch` were all deleted and NONE were
 * reported. The change replaces each deletion with a comment explaining it —
 * and those comments name the deleted functions, so "the name no longer
 * appears in the added lines" was false. A well-documented deletion defeated
 * the detector. Meanwhile the list filled with helpers from wholly-deleted
 * test files, whose only caller is the file itself.
 */

const SERVICE = graphOf({
    nodes: [
        { id: 'sf', label: 'File', properties: { filePath: 'src/store.service.ts' } },
        { id: 's1', label: 'Method', properties: { name: 'findSimilar', filePath: 'src/store.service.ts' } },
        { id: 's2', label: 'Method', properties: { name: 'findAppKnowledge', filePath: 'src/store.service.ts' } },
        { id: 'c1', label: 'Function', properties: { name: 'gatherContext', filePath: 'src/ctx.ts' } },
        { id: 'tf', label: 'File', properties: { filePath: 'test/dead.test.ts' } },
        { id: 'h1', label: 'Function', properties: { name: 'fakeStore', filePath: 'test/dead.test.ts' } },
        { id: 'fn', label: 'Function', properties: { name: 'dead.test.ts', filePath: 'test/dead.test.ts' } },
    ],
    rels: [
        { type: 'CALLS', sourceId: 'c1', targetId: 's1' },
        { type: 'CALLS', sourceId: 'fn', targetId: 'h1' },
    ],
});

test('a deletion documented by a comment naming it is still reported as removed', () => {
    const diffFiles = [{
        filename: 'src/store.service.ts',
        patch: [
            '@@ -1,6 +1,5 @@',
            '-  async findSimilar(query) {',
            '-    return this.collection.query(query);',
            '-  }',
            '+  // `findSimilar` was removed with the ChromaDB path (ENGX-1161):',
            '+  // the collection held 0 documents, so it returned [] on every call.',
            '   async findAppKnowledge(q) { return this.os.search(q); }',
        ].join('\n'),
    }];

    const out = touchedSymbolContext(SERVICE, diffFiles);

    const gone = out.removed.find((r) => r.name === 'findSimilar');
    assert.ok(gone, 'a comment explaining the deletion hid the deletion');
    assert.deepEqual(gone.calledBy, ['gatherContext']);
});

test('a symbol merely mentioned in a comment is not called removed', () => {
    // The inverse: `findAppKnowledge` is named in a comment and still exists.
    const diffFiles = [{
        filename: 'src/store.service.ts',
        patch: [
            '@@ -1,2 +1,3 @@',
            '+  // findAppKnowledge is unaffected by this change.',
            '   async findAppKnowledge(q) { return this.os.search(q); }',
        ].join('\n'),
    }];

    const out = touchedSymbolContext(SERVICE, diffFiles);

    assert.ok(!out.removed.some((r) => r.name === 'findAppKnowledge'));
});

test('helpers inside a wholly deleted file are not listed as removed symbols', () => {
    const diffFiles = [{
        filename: 'test/dead.test.ts',
        patch: [
            '@@ -1,3 +0,0 @@',
            '-function fakeStore() { return {}; }',
            '-it("x", () => {});',
            '-',
        ].join('\n'),
    }];

    const out = touchedSymbolContext(SERVICE, diffFiles);

    assert.deepEqual(
        out.removed.map((r) => r.name), [],
        'a deleted file\'s own helpers crowd out the symbols the change removes',
    );
    assert.deepEqual(out.filesDeleted, ['test/dead.test.ts']);
});

test('a symbol is not reported as called by its own file', () => {
    const diffFiles = [{
        filename: 'test/dead.test.ts',
        patch: '@@ -1,1 +1,1 @@\n-function fakeStore() { return {}; }\n+const fakeStore = 1;',
    }];

    const out = touchedSymbolContext(SERVICE, diffFiles);
    const helper = out.symbols.find((s) => s.name === 'fakeStore');

    assert.ok(helper);
    assert.deepEqual(
        helper.calledBy, [],
        'the file node named after the file itself is reported as a caller',
    );
});

test('a removed symbol found by the leftover pass is still reported as removed', () => {
    // The two-pass budget had two behaviours: the allowance pass checked for
    // removal, the leftover pass did not. On the real review that put
    // `findSimilar`, `findSimilarBatch`, `addTestCases` and `buildContext` in
    // `symbols` and none of them in `removed` — the four deletions the whole
    // change is named after.
    const wide = graphOf({
        nodes: [
            { id: 'f', label: 'File', properties: { filePath: 'src/svc.ts' } },
            ...Array.from({ length: 8 }, (_unused, i) => ({
                id: `n${i}`,
                label: 'Method',
                properties: { name: `gone${i}`, filePath: 'src/svc.ts' },
            })),
            { id: 'o', label: 'File', properties: { filePath: 'src/other.ts' } },
            { id: 'o1', label: 'Function', properties: { name: 'stillHere', filePath: 'src/other.ts' } },
        ],
        rels: [],
    });
    const diffFiles = [
        {
            filename: 'src/svc.ts',
            patch: [
                '@@ -1,9 +1,1 @@',
                ...Array.from({ length: 8 }, (_unused, i) => `-  async gone${i}() {}`),
                ' const keep = 1;',
            ].join('\n'),
        },
        { filename: 'src/other.ts', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
    ];

    // An allowance of 2 per file forces most of `svc.ts` into the leftover pass.
    const out = touchedSymbolContext(wide, diffFiles, { maxSymbols: 4 });

    const inSymbols = out.symbols.filter((s) => s.file === 'src/svc.ts').map((s) => s.name);
    const inRemoved = out.removed.map((r) => r.name);
    for (const name of inSymbols) {
        assert.ok(
            inRemoved.includes(name),
            `${name} is listed as touched but not as removed, though its declaration is deleted`,
        );
    }
});

/**
 * `removed`, decided against the head revision instead of guessed from hunks.
 *
 * The hunk heuristic produced 2 false entries in 20 on the real review:
 * `findAppKnowledge` and `get` are KEPT, and were reported removed because the
 * change rewrote a doc comment that mentioned them while their declarations sat
 * outside the hunk. Guessing from patch text cannot answer "does this file
 * still declare it" — reading the file at the reviewed revision can, and the
 * revision is already fetched for the static section.
 */

test('a symbol whose jsdoc was rewritten but which still exists is not removed', () => {
    const diffFiles = [{
        filename: 'src/svc.ts',
        patch: [
            '@@ -1,4 +1,4 @@',
            '-  /** Query app-knowledge from the app_knowledge collection. */',
            '+  /** Query app-knowledge (mved_crawled_data_prod_v2 in OpenSearch). */',
            '-  // findAppKnowledge used the ChromaDB soft floor',
            '+  // findAppKnowledge uses the OpenSearch soft floor',
        ].join('\n'),
    }];
    const graph = graphOf({
        nodes: [
            { id: 'f', label: 'File', properties: { filePath: 'src/svc.ts' } },
            { id: 'n', label: 'Method', properties: { name: 'findAppKnowledge', filePath: 'src/svc.ts' } },
        ],
        rels: [],
    });

    const out = touchedSymbolContext(graph, diffFiles, {
        headContentByPath: new Map([[
            'src/svc.ts',
            '  /** Query app-knowledge (mved_crawled_data_prod_v2). */\n'
            + '  async findAppKnowledge(query) { return this.os.search(query); }\n',
        ]]),
    });

    assert.deepEqual(
        out.removed.map((r) => r.name), [],
        'a kept symbol is reported as removed because its comment changed',
    );
});

test('a symbol absent from the head revision is removed even if a comment names it', () => {
    const diffFiles = [{
        filename: 'src/svc.ts',
        patch: [
            '@@ -1,3 +1,2 @@',
            '-  async findSimilar(q) { return this.chroma.query(q); }',
            '+  // `findSimilar` was removed with the ChromaDB path (ENGX-1161).',
        ].join('\n'),
    }];
    const graph = graphOf({
        nodes: [
            { id: 'f', label: 'File', properties: { filePath: 'src/svc.ts' } },
            { id: 'n', label: 'Method', properties: { name: 'findSimilar', filePath: 'src/svc.ts' } },
        ],
        rels: [],
    });

    const out = touchedSymbolContext(graph, diffFiles, {
        headContentByPath: new Map([[
            'src/svc.ts',
            '  // `findSimilar` was removed with the ChromaDB path (ENGX-1161).\n'
            + '  async findAppKnowledge(q) { return this.os.search(q); }\n',
        ]]),
    });

    assert.deepEqual(out.removed.map((r) => r.name), ['findSimilar']);
});

test('a symbol still CALLED at head but no longer declared is reported removed', () => {
    // The dangerous case: the declaration is gone and a call site survives in
    // the same file. That is a defect, not a reason to stay quiet.
    const diffFiles = [{
        filename: 'src/svc.ts',
        patch: '@@ -1,2 +1,1 @@\n-  async findSimilar(q) { return 1; }\n+  const unused = 0;',
    }];
    const graph = graphOf({
        nodes: [
            { id: 'f', label: 'File', properties: { filePath: 'src/svc.ts' } },
            { id: 'n', label: 'Method', properties: { name: 'findSimilar', filePath: 'src/svc.ts' } },
        ],
        rels: [],
    });

    const out = touchedSymbolContext(graph, diffFiles, {
        headContentByPath: new Map([['src/svc.ts', '  const x = this.findSimilar(1);\n']]),
    });

    assert.deepEqual(out.removed.map((r) => r.name), ['findSimilar']);
});

test('without head content it falls back to the hunk heuristic', () => {
    const diffFiles = [{
        filename: 'src/store.js',
        patch: '@@ -1,2 +1,1 @@\n-  async findSimilar(query) {\n+  const keep = 1;',
    }];

    const out = touchedSymbolContext(SAMPLE, diffFiles);

    assert.deepEqual(out.removed.map((r) => r.name), ['findSimilar']);
    assert.match(out.removedBasis || '', /hunk|patch/i);
});

test('says which basis it used to decide removal', () => {
    const out = touchedSymbolContext(SAMPLE, [{ filename: 'src/store.js', patch: '' }], {
        headContentByPath: new Map([['src/store.js', 'export function findSimilar() {}\n']]),
    });

    assert.match(out.removedBasis || '', /head revision|revision/i);
});

test('a class or interface declaration counts as still declared', () => {
    // From re-running the real review: `VectorStoreService` was reported
    // removed although the class survives — the change only dropped
    // `implements OnModuleInit` from its declaration line. `declares()`
    // required the name to be followed by `(`, `=`, `:` or `<`, and a class
    // declaration is followed by `{`. Verified failing before the fix:
    // `removed: [ 'VectorStoreService' ]`.
    const graph = graphOf({
        nodes: [
            { id: 'f', label: 'File', properties: { filePath: 'src/svc.ts' } },
            { id: 'c', label: 'Class', properties: { name: 'VectorStoreService', filePath: 'src/svc.ts' } },
            { id: 'i', label: 'Interface', properties: { name: 'MobileKbItem', filePath: 'src/svc.ts' } },
            { id: 't', label: 'Type', properties: { name: 'AppKnowledgeItem', filePath: 'src/svc.ts' } },
            { id: 'm', label: 'Method', properties: { name: 'findSimilar', filePath: 'src/svc.ts' } },
        ],
        rels: [],
    });
    const diffFiles = [{
        filename: 'src/svc.ts',
        patch: [
            '@@ -1,4 +1,3 @@',
            '-  async findSimilar(q) { return this.chroma.query(q); }',
            '-export class VectorStoreService implements OnModuleInit {',
            '-export interface MobileKbItem { id: string }',
            '-export type AppKnowledgeItem = { a: 1 };',
            '+export class VectorStoreService {',
            '+export interface MobileKbItem { id: string; score: number }',
            '+export type AppKnowledgeItem = { a: 1; b: 2 };',
        ].join('\n'),
    }];

    const out = touchedSymbolContext(graph, diffFiles, {
        headContentByPath: new Map([[
            'src/svc.ts',
            'export class VectorStoreService {\n'
            + 'export interface MobileKbItem { id: string; score: number }\n'
            + 'export type AppKnowledgeItem = { a: 1; b: 2 };\n',
        ]]),
    });

    // Differential, so it cannot pass by ignoring head content: `findSimilar`
    // is deleted and absent from head, the three declarations survive. A broken
    // head-content path fails one way or the other — reporting the class, or
    // missing the method.
    assert.deepEqual(out.removed.map((r) => r.name), ['findSimilar']);
    assert.match(out.removedBasis, /head revision/);
});

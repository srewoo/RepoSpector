import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDiffFiles, reviewPriority } from '../src/tools/diff.js';
import { allocateTokens } from '../src/tools/cap.js';

/**
 * How the diff itself is budgeted.
 *
 * Observed on a real 22-file merge request: the bundle rendered **1 of 26**
 * windows, and the one it kept was `AI-README.md` — a four-line prose edit,
 * the least consequential file in the change. Two causes, both here:
 *
 *   1. `capList` renders greedily in git's file order and stops at the first
 *      window that does not fit. `AI-README.md` sorts first and contains a
 *      single ~5KB prose line, so it consumed the entire grant.
 *   2. Nothing ordered windows by review value, so alphabetical order decided
 *      what a reviewer got to see.
 *
 * A reviewer needs every changed file represented, even trimmed, far more than
 * one file rendered whole.
 */

const noIndexer = { pipeline: { graph: null } };

/** A patch whose body is `lines` added lines, each `width` characters wide. */
const patch = (lines, width = 40) => [
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+${String(i).padStart(width, 'x')}`),
].join('\n');

test('source files are ordered ahead of docs', () => {
    assert.ok(
        reviewPriority('src/app.ts') < reviewPriority('AI-README.md'),
        'a prose file outranks source, which is how a review lost 25 of 26 windows',
    );
});

test('docs are ordered ahead of lockfiles and generated output', () => {
    assert.ok(reviewPriority('README.md') < reviewPriority('package-lock.json'));
    assert.ok(reviewPriority('README.md') < reviewPriority('dist/bundle.min.js'));
});

test('two source files keep their given order', () => {
    assert.equal(reviewPriority('src/a.ts'), reviewPriority('src/b.js'));
});

test('every changed file is represented when the budget is tight', () => {
    // The exact shape of the failure: one enormous prose file first in git
    // order, then the source files that actually matter.
    const files = [
        { filename: 'AI-README.md', patch: patch(4, 4000) },
        { filename: 'src/api.ts', patch: patch(6) },
        { filename: 'src/service.ts', patch: patch(6) },
        { filename: 'scripts/entrypoint.sh', patch: patch(6) },
    ];

    const out = renderDiffFiles(files, noIndexer, 2000);

    for (const file of files) {
        assert.match(
            out.text, new RegExp(file.filename.replace('.', '\\.')),
            `${file.filename} is absent from the rendered diff`,
        );
    }
});

test('the source file is shown even when a prose file could eat the budget', () => {
    const files = [
        { filename: 'AI-README.md', patch: patch(2, 8000) },
        { filename: 'src/api.ts', patch: patch(4) },
    ];

    const out = renderDiffFiles(files, noIndexer, 600);

    assert.match(out.text, /src\/api\.ts/);
});

test('says how much it trimmed rather than trimming quietly', () => {
    const files = [
        { filename: 'src/a.ts', patch: patch(200) },
        { filename: 'src/b.ts', patch: patch(200) },
    ];

    const out = renderDiffFiles(files, noIndexer, 400);

    assert.ok(out.truncated, 'trimming was not reported');
    assert.match(out.text, /trim|truncat|not shown/i);
});

test('a diff that fits is rendered whole and says nothing about trimming', () => {
    const files = [{ filename: 'src/a.ts', patch: patch(3) }];

    const out = renderDiffFiles(files, noIndexer, 4000);

    assert.equal(out.truncated, false);
    assert.doesNotMatch(out.text, /trimmed|not shown/i);
    assert.match(out.text, /xxx/);
});

test('a floor reserves a share for the section that carries the evidence', () => {
    // `hunks` is the primary evidence and used to receive an equal 1/8 share of
    // the bundle's budget alongside seven smaller sections.
    const desired = [10000, 100, 100, 100];
    const granted = allocateTokens(desired, 4000, { floors: [2000, 0, 0, 0] });

    assert.ok(granted[0] >= 2000, `floor ignored: ${granted[0]}`);
    assert.ok(granted[1] > 0, 'a small section was starved by the floor');
    assert.ok(
        granted.reduce((a, b) => a + b, 0) <= 4000,
        'granted more than the total budget',
    );
});

test('a floor never exceeds what the section actually wants', () => {
    const granted = allocateTokens([50, 1000], 4000, { floors: [2000, 0] });
    assert.equal(granted[0], 50);
});

test('allocateTokens without floors is unchanged', () => {
    assert.deepEqual(allocateTokens([100, 100], 1000), [100, 100]);
    assert.deepEqual(allocateTokens([], 1000), []);
    assert.deepEqual(allocateTokens([100, 100], 0), [0, 0]);
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';

const exec = promisify(execFile);
const TIMEOUT = 300000;

/**
 * The assembled bundle, on a change shaped like the one that exposed every
 * defect these tests exist for: a deletion that removes a symbol with a live
 * caller, drops a test file, and touches a prose file that sorts first.
 *
 * What the bundle used to do with it: render one window (of the prose file),
 * report repo-wide graph totals instead of the touched symbols, report a
 * whole-repo coverage ratio instead of the deleted tests, lint the working
 * tree, and say nothing about which revision any of it described.
 */

let dir;
let bundle;

before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-bundle-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'test'), { recursive: true });

    await fs.writeFile(
        path.join(dir, 'src/store.js'),
        'export function findSimilar(query) {\n  return embedText(query);\n}\n'
        + 'export function embedText(text) {\n  return [text.length];\n}\n',
    );
    await fs.writeFile(
        path.join(dir, 'src/context.js'),
        "import { findSimilar } from './store.js';\n"
        + 'export function gatherContext(q) {\n  return findSimilar(q);\n}\n',
    );
    await fs.writeFile(
        path.join(dir, 'test/store.test.js'),
        "import { findSimilar } from '../src/store.js';\n"
        + "it('finds', () => { findSimilar('a'); });\n",
    );
    // A prose file that sorts first in git's file order and carries one very
    // long line — the shape that consumed an entire hunks budget.
    await fs.writeFile(
        path.join(dir, 'AI-README.md'),
        `# AI-README\n\n> Last updated: rev 6\n\n${'prose '.repeat(1200)}\n`,
    );
    await git('add', '-A');
    await git('commit', '-qm', 'base');

    await git('checkout', '-q', '-b', 'feature');
    // Delete the symbol, keeping its caller. Delete its test file outright.
    await fs.writeFile(
        path.join(dir, 'src/store.js'),
        'export function embedText(text) {\n  return [text.length];\n}\n',
    );
    await fs.rm(path.join(dir, 'test/store.test.js'));
    await fs.writeFile(
        path.join(dir, 'AI-README.md'),
        `# AI-README\n\n> Last updated: rev 7\n\n${'prose '.repeat(1200)}\n`,
    );
    await git('add', '-A');
    await git('commit', '-qm', 'delete findSimilar and its test');
    await git('checkout', '-q', 'main'); // stale worktree, as in the real case

    const ctx = {
        config: {
            repo: dir, maxFiles: 100, maxToolTokens: 16384, githubToken: null, gitlabToken: null,
        },
        indexer: null,
    };
    const result = await REVIEW_PR_TOOL.handler({ range: 'main..feature' }, ctx);
    assert.equal(result.isError, undefined, `handler failed: ${result.content?.[0]?.text}`);
    bundle = result.content[0].text;
});

after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/** One section's body, by label. */
function section(label) {
    const parts = bundle.split(/\n\n(?=[a-z_]+:)/);
    const found = parts.find((p) => p.startsWith(`${label}:`));
    return found ? found.slice(label.length + 1).trim() : null;
}

test('carries a provenance section naming the reviewed revision', { timeout: TIMEOUT }, () => {
    const body = section('provenance');
    assert.ok(body, `no provenance section:\n${bundle.slice(0, 400)}`);
    const p = JSON.parse(body);
    assert.equal(p.target.kind, 'range');
    assert.ok(p.target.head, 'provenance does not name the reviewed head');
    assert.equal(p.target.diffMode, 'merge-base');
});

test('provenance separates the worktree from the reviewed revision', { timeout: TIMEOUT }, () => {
    const p = JSON.parse(section('provenance'));
    assert.ok(p.worktree.head);
    assert.notEqual(p.worktree.head, p.target.head);
});

test('provenance says which revision the static section describes', { timeout: TIMEOUT }, () => {
    const p = JSON.parse(section('provenance'));
    assert.equal(p.staticAnalysis.kind, 'revision');
});

test('graph context names the touched symbols, not just repo totals', { timeout: TIMEOUT }, () => {
    const body = section('graph_context');
    assert.ok(body, 'no graph_context section');
    const g = JSON.parse(body);
    assert.ok(Array.isArray(g.symbols), 'graph_context has no per-symbol list');
    assert.ok(
        JSON.stringify(g).includes('embedText') || JSON.stringify(g).includes('findSimilar'),
        `graph_context names none of the change's symbols: ${body.slice(0, 300)}`,
    );
});

test('covering tests names the test file the change deletes', { timeout: TIMEOUT }, () => {
    const body = section('covering_tests');
    assert.ok(body, 'no covering_tests section');
    const c = JSON.parse(body);
    assert.deepEqual(c.testFilesDeleted, ['test/store.test.js']);
});

test('every changed file appears in the hunks section', { timeout: TIMEOUT }, () => {
    const hunks = section('hunks');
    for (const file of ['src/store.js', 'AI-README.md', 'test/store.test.js']) {
        assert.match(hunks, new RegExp(file.replace('.', '\\.')), `${file} missing from hunks`);
    }
});

test('the source file is not crowded out by the prose file', { timeout: TIMEOUT }, () => {
    const hunks = section('hunks');
    assert.ok(
        hunks.indexOf('src/store.js') < hunks.indexOf('AI-README.md'),
        'the prose file is rendered before the source it describes',
    );
});

test('prior findings distinguishes "none recorded" from an empty array', { timeout: TIMEOUT }, () => {
    const body = section('prior_findings');
    assert.ok(body, 'no prior_findings section');
    assert.doesNotMatch(body.trim(), /^\[\]$/, 'a bare [] cannot say whether anything was checked');
    assert.match(body, /none|no prior/i);
});

test('the dependencies section states its own applicability', { timeout: TIMEOUT }, () => {
    const body = section('dependencies');
    assert.ok(body, 'no dependencies section');
    // This change touches no manifest, so the honest answer is "not
    // applicable" — not the old hardcoded "see plan Task 8".
    assert.doesNotMatch(body, /plan Task 8/);
    assert.match(body, /manifest|not applicable|no dependenc/i);
});

test('authors findings, but still no verdict', { timeout: TIMEOUT }, () => {
    // Deliberately flipped alongside review.test.js: `findings` is now a
    // section this tool writes. `verdict` and `recommendation` remain
    // forbidden — naming a defect is not deciding whether to merge.
    const labels = (bundle.match(/^[a-z_]+:/gm) || []).map((l) => l.slice(0, -1));
    for (const forbidden of ['verdict', 'review', 'summary', 'recommendation']) {
        assert.ok(!labels.includes(forbidden), `bundle authored a '${forbidden}' section`);
    }
    assert.ok(labels.includes('findings'));
});

test('the findings section cannot present candidates as established', { timeout: TIMEOUT }, () => {
    const body = section('findings');
    assert.ok(body, 'no findings section');
    const s = JSON.parse(body);

    // Whatever else it says, it must state whether the reasoning pass ran.
    assert.equal(typeof s.modelPass?.ran, 'boolean');
    if (!s.modelPass.ran) {
        // The property, not one phrasing of it: a reader must never be able to
        // mistake an empty findings list for a clean change. The delegated
        // wording ("their emptiness is not evidence the change is clean") says
        // the same thing as the un-delegated one, so match both.
        assert.match(s.note, /not evidence (that )?the change is clean/i);
        assert.match(s.completeness, /Incomplete review/);

        // A pass that did not run must either name where its result can still
        // come from, or admit there is nowhere. Silence is the failure mode.
        if (s.modelPass.delegated) {
            assert.equal(s.modelPass.awaiting, 'submit_review_findings');
            assert.ok(s.modelPass.reviewId, 'a delegated pass must name the id to submit against');
            assert.match(s.note, /submit_review_findings/);
        }
    }
    for (const f of s.findings || []) {
        assert.ok(f.assertionLevel, 'every finding declares how strong a claim it is');
        assert.notEqual(f.assertionLevel, 'validated', 'nothing here is validated in this review');
    }
});

test('names references to removed symbols that survive outside the diff', { timeout: TIMEOUT }, () => {
    // The structural blind spot, made visible: `gatherContext` in
    // `src/context.js` still calls `findSimilar`, and that file is not in the
    // change. Four of six findings on the real merge request had this shape.
    const body = section('surviving_references');
    assert.ok(body, `no surviving_references section:\n${bundle.slice(0, 400)}`);
    const s = JSON.parse(body);

    const hit = (s.references || []).find((r) => r.name === 'findSimilar');
    assert.ok(hit, `findSimilar's surviving caller was not reported: ${body.slice(0, 400)}`);
    assert.ok(
        hit.files.some((f) => f.path === 'src/context.js'),
        `the untouched caller file is missing: ${JSON.stringify(hit.files)}`,
    );
});

test('does not report the changed file itself as a surviving reference', { timeout: TIMEOUT }, () => {
    const s = JSON.parse(section('surviving_references'));
    for (const ref of s.references || []) {
        for (const file of ref.files) {
            assert.notEqual(file.path, 'src/store.js', 'the diff\'s own file is reported as a leftover');
        }
    }
});

test('prior findings names why it is empty, not merely that it is', { timeout: TIMEOUT }, () => {
    const body = section('prior_findings');
    const p = JSON.parse(body);
    assert.deepEqual(p.related, []);
    // "none recorded for this repository" implies a store that happens to be
    // empty. There is no store: no feedback ledger is wired, and this server
    // authors no findings to put in one.
    assert.match(p.note, /ledger|no source|cannot be/i);
    assert.doesNotMatch(p.note, /no prior review findings are stored for this repository/);
});

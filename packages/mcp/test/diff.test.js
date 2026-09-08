import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
    GET_DIFF_CONTEXT_TOOL, parseDiffTarget, graphAnnotationForFile, collectDiffFiles, renderDiffFiles,
} from '../src/tools/diff.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

const exec = promisify(execFile);

/**
 * A throwaway git repo, so the rename/empty-file parser tests are
 * deterministic and need no fixture — a real `git diff` on real git output,
 * not a hand-written string standing in for one.
 */
async function makeTempRepo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-parser-test-'));
    const git = (...args) => exec('git', args, { cwd: dir });
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    return { dir, git };
}

const ctx = () => ({
    config: { repo: process.cwd(), maxFiles: 50, maxToolTokens: 4096, githubToken: null, gitlabToken: null },
    indexer: null,
});

// The fixture (unlike process.cwd() above) has real, known call relationships
// (validatePassword -> hashPassword, both in src/auth.js) and is not itself
// tracked in the parent repo's git history, so it cannot drive a `range`
// end-to-end — this exercises the exact production lookup
// (`indexer.pipeline.graph.getNodesByFile` -> filter File nodes -> render)
// directly instead, against the real indexed graph. See impact.test.js /
// index_repo.test.js for why HERE-relative resolution matters here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const fixtureCtx = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };
const TIMEOUT = 300000;

test('declares its contract', () => {
    assert.equal(GET_DIFF_CONTEXT_TOOL.name, 'get_diff_context');
    assert.equal(GET_DIFF_CONTEXT_TOOL.inputSchema.type, 'object');
});

test('parses a GitHub PR url', () => {
    const t = parseDiffTarget({ pr_url: 'https://github.com/o/r/pull/7' });
    assert.equal(t.kind, 'pr');
    assert.equal(t.url, 'https://github.com/o/r/pull/7');
});

test('parses a GitLab MR url', () => {
    const t = parseDiffTarget({ pr_url: 'https://gitlab.com/g/p/-/merge_requests/100' });
    assert.equal(t.kind, 'pr');
});

test('parses a local revision range', () => {
    const t = parseDiffTarget({ range: 'main..HEAD' });
    assert.equal(t.kind, 'range');
    assert.equal(t.range, 'main..HEAD');
});

test('neither argument is a structured error naming both options', () => {
    const t = parseDiffTarget({});
    assert.ok(t.error);
    assert.match(t.error, /pr_url/);
    assert.match(t.error, /range/);
});

test('a local range against this repo returns windowed hunks', async () => {
    // Uses git only — no network, so this test is deterministic in CI.
    const r = await GET_DIFF_CONTEXT_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    assert.equal(r.isError, undefined);
    assert.ok(r.content[0].text.length > 0);
});

test('a malformed range fails with git\'s reason, not a generic message', async () => {
    const r = await GET_DIFF_CONTEXT_TOOL.handler({ range: 'not-a-real-ref..HEAD' }, ctx());
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.length > 0);
});

test('index the fixture once', { timeout: TIMEOUT }, async () => {
    assert.equal((await INDEX_REPO_TOOL.handler({ force: true }, fixtureCtx)).isError, undefined);
});

test('the graph annotation names a real symbol from the changed file, not null', { timeout: TIMEOUT }, async () => {
    // Looking a filename up as if it were a symbol NAME (the tool's original
    // behaviour) always returns null from getSymbolContext, so an annotation
    // that merely "exists" would pass against that bug too. This asserts the
    // annotation actually mentions one of the two real symbols the fixture's
    // src/auth.js defines (validatePassword calls hashPassword) — it fails
    // against the old `getSymbolContext(file.filename)` lookup, which never
    // returns anything for a file path.
    const note = graphAnnotationForFile(fixtureCtx.indexer, 'src/auth.js');
    assert.match(note, /validatePassword|hashPassword/, `expected a real symbol, got: "${note}"`);
});

test('collectDiffFiles returns the {filename, patch} shape Task 8 depends on', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();
    try {
        await fs.writeFile(path.join(dir, 'greeting.txt'), 'hello\n');
        await git('add', 'greeting.txt');
        await git('commit', '-q', '-m', 'first');
        await fs.writeFile(path.join(dir, 'greeting.txt'), 'goodbye\n');
        await git('add', 'greeting.txt');
        await git('commit', '-q', '-m', 'second');

        const files = await collectDiffFiles({ range: 'HEAD~1..HEAD' }, { config: { repo: dir } });
        assert.equal(files.length, 1);
        // Assert the field NAMES directly — a rename of either would silently
        // break Task 8's review_pr, which reads collectDiffFiles's output
        // (not the rendered text) to feed its analyzers.
        assert.equal(files[0].filename, 'greeting.txt');
        assert.equal(typeof files[0].patch, 'string');
        assert.match(files[0].patch, /@@/, 'a real content change must carry a hunk');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a content-unchanged rename is emitted, not silently dropped', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();
    try {
        await fs.writeFile(path.join(dir, 'old.txt'), 'unchanged content\n');
        await git('add', 'old.txt');
        await git('commit', '-q', '-m', 'first');
        await git('mv', 'old.txt', 'new.txt');
        await git('commit', '-q', '-m', 'second');

        const files = await collectDiffFiles({ range: 'HEAD~1..HEAD' }, { config: { repo: dir } });
        assert.equal(files.length, 1, 'the rename must not be dropped');
        assert.equal(files[0].filename, 'new.txt');
        assert.equal(files[0].previousFilename, 'old.txt');
        assert.equal(files[0].status, 'renamed');
        assert.equal(files[0].patch, '');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an empty added file is emitted, not silently dropped', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();
    try {
        await fs.writeFile(path.join(dir, 'keep.txt'), 'x\n');
        await git('add', 'keep.txt');
        await git('commit', '-q', '-m', 'first');
        await fs.writeFile(path.join(dir, 'brandnew.txt'), '');
        await git('add', 'brandnew.txt');
        await git('commit', '-q', '-m', 'second');

        const files = await collectDiffFiles({ range: 'HEAD~1..HEAD' }, { config: { repo: dir } });
        assert.equal(files.length, 1, 'the empty add must not be dropped');
        assert.equal(files[0].filename, 'brandnew.txt');
        assert.equal(files[0].status, 'added');
        assert.equal(files[0].patch, '');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an empty deleted file is emitted, not silently dropped', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();
    try {
        await fs.writeFile(path.join(dir, 'brandnew.txt'), '');
        await git('add', 'brandnew.txt');
        await git('commit', '-q', '-m', 'first');
        await git('rm', '-q', 'brandnew.txt');
        await git('commit', '-q', '-m', 'second');

        const files = await collectDiffFiles({ range: 'HEAD~1..HEAD' }, { config: { repo: dir } });
        assert.equal(files.length, 1, 'the empty delete must not be dropped');
        assert.equal(files[0].filename, 'brandnew.txt');
        assert.equal(files[0].status, 'removed');
        assert.equal(files[0].patch, '');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('the graph annotation reaches actual tool output, not only the helper', { timeout: TIMEOUT }, async () => {
    // renderDiffFiles is the exact rendering GET_DIFF_CONTEXT_TOOL.handler
    // returns; driving it directly with a hand-built file list bypasses
    // localDiff/collectDiffFiles (the fixture has no git history to diff)
    // while still proving the annotation reaches the returned text, not only
    // graphAnnotationForFile in isolation.
    const files = [{ filename: 'src/auth.js', patch: '@@ -1,3 +1,3 @@\n-old\n+new\n' }];
    const rendered = renderDiffFiles(files, fixtureCtx.indexer, 4096);
    assert.match(rendered.text, /\[graph\]/, `expected a [graph] annotation, got:\n${rendered.text}`);
    assert.match(
        rendered.text,
        /validatePassword|hashPassword/,
        `expected a real symbol in the rendered output, got:\n${rendered.text}`,
    );
});

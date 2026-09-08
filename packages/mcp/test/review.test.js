import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';

const exec = promisify(execFile);
const TIMEOUT = 300000;
const ctx = () => ({
    config: { repo: process.cwd(), maxFiles: 200, maxToolTokens: 16384, githubToken: null, gitlabToken: null },
    indexer: null,
});

test('declares its contract', () => {
    assert.equal(REVIEW_PR_TOOL.name, 'review_pr');
    assert.equal(REVIEW_PR_TOOL.inputSchema.type, 'object');
    // The description must not promise findings — it returns material.
    assert.doesNotMatch(REVIEW_PR_TOOL.description, /generates? (the )?(review|findings)/i);
});

test('the bundle carries every declared section', { timeout: TIMEOUT }, async () => {
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    assert.equal(r.isError, undefined);
    const text = r.content[0].text;
    for (const section of ['hunks', 'rubric', 'graph_context', 'similar_code',
        'covering_tests', 'prior_findings', 'static_analysis']) {
        assert.match(text, new RegExp(section, 'i'), `bundle is missing ${section}:\n${text.slice(0, 600)}`);
    }
});

test('the bundle contains no generated findings and no verdict', { timeout: TIMEOUT }, async () => {
    // The keyless invariant made observable: if a future change wires an LLM in,
    // this test is what notices.
    //
    // Scanning the whole bundle for phrases cannot express that. The bundle
    // carries evidence — retrieved source, diff hunks, real linter and
    // secret-scan output — which is arbitrary repo text: `static_analysis`
    // legitimately reports `"severity": "high"` from the linter, and when the
    // repo under review is this package, `similar_code` retrieves this very
    // file and matches on the assertion string itself. So assert on what
    // review_pr AUTHORS: its section labels, and the rubric it writes.
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    const text = r.content[0].text;

    const labels = (text.match(/^[a-z_]+:/gm) || []).map((l) => l.slice(0, -1));
    for (const forbidden of ['findings', 'verdict', 'review', 'summary', 'recommendation']) {
        assert.ok(
            !labels.includes(forbidden),
            `bundle authored a '${forbidden}' section — review_pr returns material, not conclusions`,
        );
    }

    // The rubric instructs a reader; it must not itself reach a conclusion.
    const rubric = text.split('\n\n').find((p) => p.startsWith('rubric:')) || '';
    assert.ok(rubric.length > 0, 'rubric section missing');
    assert.doesNotMatch(rubric.toLowerCase(), /overall verdict/);
    assert.doesNotMatch(rubric.toLowerCase(), /"severity":\s*"(critical|high)"/);
});

test('a section whose analyzer fails is named as unavailable, not dropped', { timeout: TIMEOUT }, async () => {
    // A missing section that says why is recoverable; a silently absent one makes
    // the reader assume the check passed.
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    const text = r.content[0].text;
    const sections = (text.match(/^[a-z_]+:/gm) || []).length;
    assert.ok(sections >= 7, `expected at least 7 labelled sections, found ${sections}`);
});

test('neither target argument is a structured error', async () => {
    const r = await REVIEW_PR_TOOL.handler({}, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /pr_url|range/);
});

/**
 * Ruling 1 test — required beyond the brief.
 *
 * The brief's own static_analysis code passed `files = []` to both
 * analyzers, which would make this section always empty even though it is
 * the strongest reason review_pr earns its place (real ESLint/Semgrep/
 * secret-scan output, no model involved). review.js instead feeds
 * SecretsScanner from collectDiffFiles's {filename, patch} entries directly,
 * and StaticAnalysisService from readRepoFiles's {path, content} entries
 * filtered to the changed filenames. This proves that wiring reaches real
 * tool output for a range that actually touches a JavaScript file, using a
 * throwaway git repo so the result is deterministic and needs no fixture.
 */
async function makeTempRepo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-static-analysis-test-'));
    const git = (...args) => exec('git', args, { cwd: dir });
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    return { dir, git };
}

// Regression: similar_code read `res.chunks || res.results` off the return of
// retrieveContext, which is a FLAT ARRAY unless called with formatOutput. Both
// keys were undefined, so the section shipped `[]` on every single review while
// real retrieval results sat one dereference away.
test('similar_code carries real retrieved chunks, not an empty array', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();

    await fs.writeFile(
        path.join(dir, 'auth.js'),
        'export function validatePassword(user, password) {\n'
        + '    return hashPassword(password) === user.passwordHash;\n}\n'
        + 'export function hashPassword(p) {\n    return `hashed:${p}`;\n}\n',
    );
    await git('add', '.');
    await git('commit', '-q', '-m', 'first');

    await fs.writeFile(
        path.join(dir, 'auth.js'),
        'export function validatePassword(user, password) {\n'
        + '    return hashPassword(password) === user.passwordHash;\n}\n'
        + 'export function hashPassword(p) {\n    return `hashed:v2:${p}`;\n}\n',
    );
    await git('add', '.');
    await git('commit', '-q', '-m', 'change the hash scheme');

    const localCtx = {
        config: {
            repo: dir, maxFiles: 50, maxToolTokens: 16384, githubToken: null, gitlabToken: null,
        },
        indexer: null,
    };
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, localCtx);
    assert.equal(r.isError, undefined);

    const text = r.content[0].text;
    const part = text.split('\n\n').find((p) => p.startsWith('similar_code:'));
    assert.ok(part, `similar_code section not found:\n${text.slice(0, 800)}`);

    const body = part.slice('similar_code:'.length).trim();
    assert.notEqual(body, '[]', 'similar_code shipped an empty array despite an indexed repo');

    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed) && parsed.length > 0, `expected chunks, got ${body.slice(0, 200)}`);
    for (const c of parsed) {
        assert.ok(c.filePath, 'a similar_code chunk has no filePath');
        assert.doesNotMatch(c.filePath, /undefined|unknown/);
        assert.ok(typeof c.content === 'string' && c.content.length > 0, 'chunk has no content');
    }
    assert.ok(parsed.some((c) => c.filePath.includes('auth.js')), `expected auth.js in ${body.slice(0, 200)}`);
});

// Regression: the chunker emits whole-file chunks, so on a real repo one 8KB
// doc file consumed the entire similar_code section and the other four chunks
// were cut by the token limit. Every retrieved chunk must survive, trimmed.
test('no single similar_code chunk crowds out the others', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();

    // One deliberately huge file plus several small ones, all plausibly similar.
    await fs.writeFile(path.join(dir, 'huge.js'), `// ${'padding text about sessions and passwords. '.repeat(900)}\nexport function huge() { return 'session password'; }\n`);
    for (const n of ['a', 'b', 'c']) {
        await fs.writeFile(
            path.join(dir, `${n}.js`),
            `export function ${n}Session(password) {\n    return password.length > 0;\n}\n`,
        );
    }
    await fs.writeFile(path.join(dir, 'target.js'), 'export function check(p) {\n    return p;\n}\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'first');

    await fs.writeFile(path.join(dir, 'target.js'), 'export function check(password) {\n    return password.length > 0;\n}\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'validate the session password');

    const localCtx = {
        config: {
            repo: dir, maxFiles: 50, maxToolTokens: 8192, githubToken: null, gitlabToken: null,
        },
        indexer: null,
    };
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, localCtx);
    assert.equal(r.isError, undefined);

    const text = r.content[0].text;
    const part = text.split('\n\n').find((p) => p.startsWith('similar_code:'));
    assert.ok(part, 'similar_code section missing');

    // The section must not be cut off mid-JSON: every chunk still listed.
    assert.doesNotMatch(part, /truncated at the token limit/, 'similar_code overran its share');

    // Must still be valid JSON — the old failure sliced it mid-structure.
    const parsed = JSON.parse(part.slice('similar_code:'.length).trim());
    assert.ok(parsed.length > 1, `expected several chunks, got ${parsed.length}`);

    // Every retrieved chunk survives with its identity intact. Spending the
    // leftover budget on the biggest chunk is fine; silently dropping the
    // others is what broke — they vanished with the truncated tail.
    for (const c of parsed) {
        assert.ok(c.filePath, 'a chunk lost its path');
        assert.ok(c.content.length > 0, `chunk ${c.filePath} was trimmed to nothing`);
    }
    assert.ok(
        parsed.some((c) => c.truncated),
        'the oversized chunk should be marked truncated, not silently cut',
    );
});

test('static_analysis is non-empty for a range that touches a real JavaScript file', { timeout: TIMEOUT }, async () => {
    const { dir, git } = await makeTempRepo();

    await fs.writeFile(
        path.join(dir, 'widget.js'),
        'export function add(a, b) {\n    return a + b;\n}\n',
    );
    await git('add', '.');
    await git('commit', '-q', '-m', 'first');

    await fs.writeFile(
        path.join(dir, 'widget.js'),
        'export function add(a, b) {\n    eval("1 + 1");\n    return a + b;\n}\n',
    );
    await git('add', '.');
    await git('commit', '-q', '-m', 'second');

    const localCtx = {
        config: {
            repo: dir, maxFiles: 50, maxToolTokens: 16384, githubToken: null, gitlabToken: null,
        },
        indexer: null,
    };
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, localCtx);
    assert.equal(r.isError, undefined);

    const text = r.content[0].text;
    const staticPart = text.split('\n\n').find((p) => p.startsWith('static_analysis:'));
    assert.ok(staticPart, `static_analysis section not found:\n${text.slice(0, 800)}`);
    assert.ok(staticPart.trim().length > 'static_analysis:'.length, 'static_analysis section is empty');
    assert.match(
        staticPart,
        /widget\.js/,
        'static_analysis must reflect the file the diff actually touched, not an empty file list',
    );
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiffTarget, parseUnifiedDiff, GET_DIFF_CONTEXT_TOOL } from '../src/tools/diff.js';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const TIMEOUT = 300000;

/**
 * Why this exists: the diff tools insisted on fetching the diff themselves,
 * which meant a GITHUB_TOKEN / GITLAB_TOKEN even for users whose client already
 * has an authenticated GitLab or GitHub MCP server connected. Accepting the
 * diff text lets that server supply it, so RepoSpector makes no network call
 * and needs no credential of its own.
 */

const DIFF = `diff --git a/src/auth.js b/src/auth.js
index 1111111..2222222 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -1,3 +1,3 @@
 export function validatePassword(user, password) {
-    return hashPassword(password) === user.passwordHash;
+    return hashPassword(password) == user.passwordHash;
 }
`;

const ctx = () => ({
    config: {
        repo: FIXTURE, maxFiles: 50, maxToolTokens: 8192, githubToken: null, gitlabToken: null,
    },
    indexer: null,
});

test('parseDiffTarget accepts a diff, and prefers it over a URL', () => {
    assert.deepEqual(parseDiffTarget({ diff: 'x' }), { kind: 'diff', diff: 'x' });
    // Already-held text beats a fetch: no network call, no token.
    assert.equal(parseDiffTarget({ diff: 'x', pr_url: 'https://y', range: 'a..b' }).kind, 'diff');
});

test('parseDiffTarget still names every accepted input when given none', () => {
    const { error } = parseDiffTarget({});
    for (const word of ['diff', 'pr_url', 'range']) assert.match(error, new RegExp(word));
});

test('parseUnifiedDiff splits files and keeps the hunk', () => {
    const files = parseUnifiedDiff(DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'src/auth.js');
    assert.match(files[0].patch, /^@@ -1,3 \+1,3 @@/);
    assert.match(files[0].patch, /hashPassword\(password\) == user\.passwordHash/);
});

test('parseUnifiedDiff classifies a rename with no hunk rather than dropping it', () => {
    const renamed = `diff --git a/old.js b/new.js
similarity index 100%
rename from old.js
rename to new.js
`;
    const [file] = parseUnifiedDiff(renamed);
    assert.equal(file.filename, 'new.js');
    assert.equal(file.status, 'renamed');
    assert.equal(file.previousFilename, 'old.js');
});

test('parseUnifiedDiff invents no file for empty or junk input', () => {
    // It used to return a phantom {filename: 'unknown'} for any non-diff text,
    // so review_pr would report analysis against a file that does not exist.
    assert.deepEqual(parseUnifiedDiff(''), []);
    assert.deepEqual(parseUnifiedDiff(undefined), []);
    assert.deepEqual(parseUnifiedDiff('not a diff at all'), []);
    assert.deepEqual(parseUnifiedDiff('{"error":"unauthorized"}'), []);
});

test('parseUnifiedDiff reads a plain diff -u with no git header', () => {
    // A client fetching via another MCP server may hand over this form;
    // rejecting it would push the user back to configuring a token here.
    const plain = `--- a/src/session.js\t2026-09-08
+++ b/src/session.js\t2026-09-08
@@ -4,2 +4,2 @@
-const TTL = 60;
+const TTL = 120;
`;
    const [file] = parseUnifiedDiff(plain);
    assert.equal(file.filename, 'src/session.js');
    assert.match(file.patch, /TTL = 120/);
});

test('parseUnifiedDiff names a deleted file from the old side', () => {
    const removed = `--- a/src/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
`;
    const [file] = parseUnifiedDiff(removed);
    assert.equal(file.filename, 'src/gone.js');
    assert.equal(file.status, 'removed');
});

test('get_diff_context renders a supplied diff with no token configured', { timeout: TIMEOUT }, async () => {
    const r = await GET_DIFF_CONTEXT_TOOL.handler({ diff: DIFF }, ctx());
    assert.equal(r.isError, undefined);
    const text = r.content[0].text;
    assert.match(text, /--- src\/auth\.js/);
    assert.match(text, /hashPassword/);
});

test('review_pr builds the full bundle from a supplied diff', { timeout: TIMEOUT }, async () => {
    // The whole point: no pr_url, no range, no credential.
    const c = ctx();
    assert.equal(c.config.gitlabToken, null);
    const r = await REVIEW_PR_TOOL.handler({ diff: DIFF }, c);
    assert.equal(r.isError, undefined);

    const text = r.content[0].text;
    const labels = (text.match(/^[a-z_]+:/gm) || []).map((l) => l.slice(0, -1));
    for (const section of ['rubric', 'hunks', 'similar_code', 'graph_context',
        'covering_tests', 'prior_findings', 'static_analysis']) {
        assert.ok(labels.includes(section), `bundle is missing ${section}: ${labels}`);
    }
    // static_analysis must reflect the file the supplied diff touched.
    const staticPart = text.split('\n\n').find((p) => p.startsWith('static_analysis:'));
    assert.match(staticPart, /auth\.js/);
});

test('review_pr accepts diff and repo together', { timeout: TIMEOUT }, async () => {
    const r = await REVIEW_PR_TOOL.handler({ diff: DIFF, repo: FIXTURE }, ctx());
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /--- src\/auth\.js/);
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFilesAtRev } from '../src/repo/source.js';
import { resolveReviewRev, filesForStaticAnalysis } from '../src/tools/reviewRevision.js';

const exec = promisify(execFile);

/**
 * Which revision the static section describes.
 *
 * The bug this file exists for: `review_pr` linted the WORKING TREE while its
 * hunks came from a revision range. On a real review that worktree was 537
 * commits behind the range's base, and the linter reported three findings on a
 * schema the merge request DELETES — code that exists in no revision the
 * reviewer was looking at. Two halves of one bundle described different code,
 * and nothing in the output said so.
 */

/** A repo whose worktree deliberately disagrees with the branch under review. */
async function repoWithDivergentWorktree() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-rev-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    // main: a real duplicate key, which the regex rule genuinely flags.
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
        path.join(dir, 'src/config.js'),
        'export const config = { host: "a", port: 1, host: "b" };\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'base with a duplicate key');

    // feature: the duplicate is deleted. This is the revision under review.
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(
        path.join(dir, 'src/config.js'),
        'export const config = { host: "a", port: 1 };\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'drop the duplicate key');

    // Leave the worktree on main — the stale state that caused the bug.
    await git('checkout', '-q', 'main');

    return dir;
}

test('reads a file at a revision that is not the working tree', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const { files, missing } = await readFilesAtRev(dir, 'feature', ['src/config.js']);

        assert.equal(missing.length, 0);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, 'src/config.js');
        assert.doesNotMatch(
            files[0].content,
            /host: "b"/,
            'read the worktree (main) instead of the requested revision (feature)',
        );
        assert.match(files[0].content, /port: 1 \};/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a path absent from the revision is reported, not silently dropped', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const { files, missing } = await readFilesAtRev(dir, 'feature', [
            'src/config.js',
            'src/deleted-by-this-change.js',
        ]);

        assert.equal(files.length, 1);
        assert.deepEqual(missing, ['src/deleted-by-this-change.js']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('resolves the head side of a two-dot range', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const r = await resolveReviewRev({ range: 'main..feature' }, dir);
        assert.equal(r.kind, 'revision');
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        assert.equal(r.rev, stdout.trim());
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('resolves the head side of a three-dot range', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const r = await resolveReviewRev({ range: 'main...feature' }, dir);
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        assert.equal(r.rev, stdout.trim());
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a single-revision range means that revision', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const r = await resolveReviewRev({ range: 'feature' }, dir);
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        assert.equal(r.rev, stdout.trim());
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a pasted diff has no resolvable revision and says so', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const r = await resolveReviewRev({ diff: 'diff --git a/x b/x\n' }, dir);
        assert.equal(r.kind, 'added-lines');
        assert.equal(r.rev, null);
        assert.match(r.reason, /diff/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an unresolvable range does not fall back to the working tree', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const r = await resolveReviewRev({ range: 'main..no-such-branch' }, dir);
        assert.equal(r.kind, 'added-lines');
        assert.equal(r.rev, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('lints file contents from the reviewed revision, not the worktree', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const diffFiles = [{
            filename: 'src/config.js',
            patch: [
                '@@ -1,1 +1,1 @@',
                '-export const config = { host: "a", port: 1, host: "b" };',
                '+export const config = { host: "a", port: 1 };',
            ].join('\n'),
        }];

        const { files, source } = await filesForStaticAnalysis(
            { range: 'main..feature' }, dir, diffFiles, { maxFiles: 200 },
        );

        assert.equal(source.kind, 'revision');
        assert.equal(files.length, 1);
        assert.doesNotMatch(
            files[0].content,
            /host: "b"/,
            'linted the deleted duplicate — the exact wrong-revision defect',
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('falls back to the patch added lines when no revision resolves', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const diffFiles = [{
            filename: 'src/config.js',
            patch: [
                '@@ -1,1 +1,2 @@',
                ' export const config = { host: "a", port: 1 };',
                '+export const extra = { a: 1, a: 2 };',
            ].join('\n'),
        }];

        const { files, source } = await filesForStaticAnalysis(
            { diff: 'anything' }, dir, diffFiles, { maxFiles: 200 },
        );

        assert.equal(source.kind, 'added-lines');
        assert.equal(files.length, 1);
        // Only the added line, and carrying the map back to real file lines.
        assert.match(files[0].content, /export const extra/);
        assert.doesNotMatch(files[0].content, /port: 1/);
        assert.deepEqual(files[0].lineNumbers, [2]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('skips files the indexer would not treat as code', async () => {
    // `readRepoFiles` filtered by `isIndexableCodeFile`, so lockfiles, minified
    // bundles and binaries never reached the analyzers. Reading blobs at a
    // revision must keep that filter, or a review of a change that touches
    // `package-lock.json` hands a megabyte of generated JSON to the linter.
    const dir = await repoWithDivergentWorktree();
    try {
        const diffFiles = [
            { filename: 'src/config.js', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
            { filename: 'package-lock.json', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
            { filename: 'dist/bundle.min.js', patch: '@@ -1,1 +1,1 @@\n-a\n+b' },
        ];

        const { files } = await filesForStaticAnalysis(
            { range: 'main..feature' }, dir, diffFiles, { maxFiles: 200 },
        );

        assert.deepEqual(files.map((f) => f.path), ['src/config.js']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a caller that asks for manifests gets them despite that filter', async () => {
    // The dependency section's whole subject is the manifest, so it opts out.
    const dir = await repoWithDivergentWorktree();
    try {
        const git = (...args) => exec('git', args, { cwd: dir });
        await git('checkout', '-q', 'feature');
        await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","dependencies":{}}\n');
        await git('add', '-A');
        await git('commit', '-qm', 'add a manifest');
        await git('checkout', '-q', 'main'); // read at feature, from a stale worktree

        const { files } = await filesForStaticAnalysis(
            { range: 'main..feature' },
            dir,
            [{ filename: 'package.json', patch: '@@ -0,0 +1,1 @@\n+{}' }],
            { filter: 'none' },
        );

        assert.deepEqual(files.map((f) => f.path), ['package.json']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('the added-lines fallback applies the same filter', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const { files } = await filesForStaticAnalysis(
            { diff: 'x' },
            dir,
            [
                { filename: 'src/a.ts', patch: '@@ -0,0 +1,1 @@\n+const a = 1;' },
                { filename: 'yarn.lock', patch: '@@ -0,0 +1,1 @@\n+lodash@1.0.0:' },
            ],
            {},
        );

        assert.deepEqual(files.map((f) => f.path), ['src/a.ts']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveReviewIdentity } from '../src/tools/reviewIdentity.js';
import { buildProvenance } from '../src/tools/provenance.js';

const exec = promisify(execFile);

/**
 * P0-2 — one revision identity per review.
 *
 * The defect: `surviving_references` chose its revision from
 * `staticSource?.rev || 'HEAD'` while `staticSource` was still null, because
 * the static section is assembled after it. A pull request review searched the
 * local worktree for surviving references and reported lint results from the
 * PR head — two revisions, one bundle, no way to tell from the output.
 */

/** main advances after `feature` is cut, so endpoint base != merge base. */
async function repoWithAdvancedTarget() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-identity-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    const { stdout: mergeBase } = await git('rev-parse', 'HEAD');

    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 2;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'feature work');

    // main moves on AFTER the branch was cut.
    await git('checkout', '-q', 'main');
    await fs.writeFile(path.join(dir, 'b.js'), 'export const b = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'unrelated main commit');

    return { dir, mergeBase: mergeBase.trim() };
}

test('a three-dot range resolves its base to the merge base, not the left endpoint', async () => {
    const { dir, mergeBase } = await repoWithAdvancedTarget();
    try {
        const id = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });

        assert.equal(id.effectiveBase, mergeBase, 'the effective base is the merge base');
        assert.notEqual(id.baseSha, mergeBase, 'the left endpoint has moved on and is a different commit');
        assert.equal(id.effectiveBaseSource, 'merge-base');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('the reviewed head is the range head, not whatever the worktree is on', async () => {
    const { dir } = await repoWithAdvancedTarget();
    try {
        const id = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });

        assert.equal(id.source.kind, 'revision');
        assert.equal(id.source.rev, stdout.trim());
        assert.notEqual(id.source.rev, id.worktree.head, 'the worktree is on main');
        assert.equal(id.hasRevision, true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a PR head absent locally leaves the revision unknown — it does not become HEAD', async () => {
    const { dir } = await repoWithAdvancedTarget();
    try {
        const id = await resolveReviewIdentity({
            args: { pr_url: 'https://github.com/o/r/pull/1' },
            repo: dir,
            headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        });

        assert.equal(id.hasRevision, false);
        assert.equal(id.source.rev, null);
        assert.notEqual(id.source.rev, id.worktree.head);
        assert.ok(id.unresolved.length > 0, 'the gap is reported rather than papered over');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a PR head that IS present locally is used for file contents', async () => {
    const { dir } = await repoWithAdvancedTarget();
    try {
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        const head = stdout.trim();
        const id = await resolveReviewIdentity({
            args: { pr_url: 'https://github.com/o/r/pull/1' }, repo: dir, headSha: head,
        });

        assert.equal(id.hasRevision, true);
        assert.equal(id.source.rev, head);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a pasted diff names no revision, and none is invented', async () => {
    const { dir } = await repoWithAdvancedTarget();
    try {
        const id = await resolveReviewIdentity({ args: { diff: '--- a\n+++ b\n' }, repo: dir });
        assert.equal(id.hasRevision, false);
        assert.equal(id.source.rev, null);
        assert.ok(id.unresolved.length > 0);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('provenance reports the identity it was given, including a PR head', async () => {
    const { dir, mergeBase } = await repoWithAdvancedTarget();
    try {
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        const identity = await resolveReviewIdentity({
            args: { pr_url: 'https://github.com/o/r/pull/1' }, repo: dir, headSha: stdout.trim(),
        });
        const p = await buildProvenance({
            args: { pr_url: 'https://github.com/o/r/pull/1' }, repo: dir, indexer: null, identity,
        });

        // Previously null for every pull request: buildProvenance only resolved
        // base/head from `args.range`.
        assert.equal(p.target.head, stdout.trim());

        const rangeIdentity = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });
        const rp = await buildProvenance({
            args: { range: 'main...feature' }, repo: dir, indexer: null, identity: rangeIdentity,
        });
        assert.equal(rp.target.base, mergeBase);
        assert.equal(rp.target.baseResolvedFrom, 'merge-base');
        assert.equal(rp.target.endpointBase, rangeIdentity.baseSha);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a dirty worktree is reported, and does not become the reviewed revision', async () => {
    // The original failure mode in miniature: the worktree is what the server
    // can most easily read, and it is the one thing that must not silently
    // stand in for the revision under review.
    const { dir } = await repoWithAdvancedTarget();
    try {
        await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 999; // uncommitted\n');

        const id = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });
        assert.equal(id.worktree.dirty, true, 'the dirty state is recorded');

        // …and the revision the sections read from is still the range head.
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });
        assert.equal(id.source.rev, stdout.trim());
        assert.notEqual(id.source.rev, id.worktree.head);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a clean worktree is reported as clean rather than as unknown', async () => {
    const { dir } = await repoWithAdvancedTarget();
    try {
        const id = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });
        assert.equal(id.worktree.dirty, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a REMOVED symbol is searched for at the reviewed head, not at the worktree', async () => {
    // The acceptance's "removed callers" case. `feature` deletes a symbol that
    // a file outside the change still calls; the search has to run at feature,
    // which is not what is checked out.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-removed-'));
    const git = (...args) => exec('git', args, { cwd: dir });
    try {
        await git('init', '-q', '-b', 'main');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'test');

        await fs.writeFile(path.join(dir, 'lib.js'), 'export function legacyHelper() { return 1; }\n');
        await fs.writeFile(path.join(dir, 'consumer.js'), 'import { legacyHelper } from "./lib.js";\nlegacyHelper();\n');
        await git('add', '-A');
        await git('commit', '-qm', 'base');

        await git('checkout', '-q', '-b', 'feature');
        await fs.writeFile(path.join(dir, 'lib.js'), 'export function replacement() { return 1; }\n');
        await git('add', '-A');
        await git('commit', '-qm', 'remove legacyHelper');

        // Leave the worktree on main — where the symbol still exists.
        await git('checkout', '-q', 'main');

        const id = await resolveReviewIdentity({ args: { range: 'main...feature' }, repo: dir });
        const { stdout } = await exec('git', ['rev-parse', 'feature'], { cwd: dir });

        assert.equal(id.hasRevision, true);
        assert.equal(id.source.rev, stdout.trim(), 'reads at the reviewed head');
        assert.notEqual(id.source.rev, id.worktree.head, 'and not at the checked-out branch');

        // The surviving reference is present at the reviewed head, which is the
        // whole point: searching the worktree would find the removed symbol too
        // and report nothing unusual.
        const { stdout: atHead } = await exec('git', ['show', `${id.source.rev}:consumer.js`], { cwd: dir });
        assert.match(atHead, /legacyHelper\(\)/);
        const { stdout: libAtHead } = await exec('git', ['show', `${id.source.rev}:lib.js`], { cwd: dir });
        assert.doesNotMatch(libAtHead, /legacyHelper/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexer } from '../src/repo/indexer.js';

const exec = promisify(execFile);
const TIMEOUT = 300000;

/**
 * Which commit the index was built from.
 *
 * The graph and retrieval sections describe a snapshot of the repository, and
 * nothing recorded WHICH one. So a caller lookup could be answered from an
 * index 537 commits away from the change under review with no way to tell —
 * the reason `provenance.index.behindReviewedBase` exists, and it cannot be
 * computed without this.
 *
 * Recorded as a sidecar next to `parser-mode.txt`, for the same reason that
 * one exists: what the persisted index describes cannot be re-derived from
 * this process on a warm start.
 */

async function gitRepo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-idx-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
        path.join(dir, 'src/auth.js'),
        'export function login(user) {\n  return validate(user);\n}\n'
        + 'export function validate(user) {\n  return Boolean(user);\n}\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'initial');

    return { dir, git };
}

test('records the commit it indexed', { timeout: TIMEOUT }, async () => {
    const { dir } = await gitRepo();
    try {
        const indexer = createIndexer({ repo: dir, maxFiles: 20, maxToolTokens: 4096 });
        await indexer.ensureIndexed({ force: true });

        const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: dir });
        assert.equal(await indexer.indexedCommit(), stdout.trim());
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a repository with no commits reports null rather than failing', { timeout: TIMEOUT }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-empty-'));
    try {
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
        await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 1;\n');

        const indexer = createIndexer({ repo: dir, maxFiles: 20, maxToolTokens: 4096 });
        await indexer.ensureIndexed({ force: true });

        assert.equal(await indexer.indexedCommit(), null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an index that predates this recording reports null, not a wrong commit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-nosidecar-'));
    try {
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
        // No ensureIndexed call at all: nothing has been recorded.
        const indexer = createIndexer({ repo: dir, maxFiles: 20, maxToolTokens: 4096 });
        assert.equal(await indexer.indexedCommit(), null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

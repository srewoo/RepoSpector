import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
    pruneOrphans, enforceSizeCap, recordRepoPath, readRepoPath, labelIfMissing, INDEX_BASE_DIR,
} from '../src/repo/cache.js';

/**
 * Why this exists: a snapshot directory is named sha256(repo path), which is
 * one-way, and nothing ever deleted one. So the cache grew without bound and
 * could not be cleaned selectively — 984 MB across 75 directories accumulated
 * in a single day of testing, most of them repositories that no longer existed.
 */

async function scratch() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'repospector-cache-'));
}

/** A snapshot directory holding `bytes` of data, optionally labelled. */
async function snapshot(base, name, repoPath, bytes = 1024) {
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'blob.v8bin'), Buffer.alloc(bytes));
    if (repoPath) await recordRepoPath(dir, repoPath);
    return dir;
}

test('the cache base is under the user home, not the repo', () => {
    assert.ok(INDEX_BASE_DIR.startsWith(os.homedir()));
    assert.match(INDEX_BASE_DIR, /\.repospector[/\\]index$/);
});

test('a recorded path round-trips; an unlabelled snapshot reads as null', async () => {
    const base = await scratch();
    const labelled = await snapshot(base, 'a', '/some/repo');
    const bare = await snapshot(base, 'b', null);
    assert.equal(await readRepoPath(labelled), '/some/repo');
    assert.equal(await readRepoPath(bare), null);
    await fs.rm(base, { recursive: true, force: true });
});

test('labelIfMissing backfills once and never overwrites', async () => {
    const base = await scratch();
    const dir = await snapshot(base, 'a', null);
    assert.equal(await labelIfMissing(dir, '/first'), true);
    assert.equal(await readRepoPath(dir), '/first');
    // Already labelled: a second call must not relabel it.
    assert.equal(await labelIfMissing(dir, '/second'), false);
    assert.equal(await readRepoPath(dir), '/first');
    await fs.rm(base, { recursive: true, force: true });
});

test('prune deletes only snapshots whose repository is really gone', async () => {
    const base = await scratch();
    const live = await scratch();
    const gone = path.join(os.tmpdir(), 'repospector-deleted-repo-does-not-exist');

    const dLive = await snapshot(base, 'live', live, 4096);
    const dDead = await snapshot(base, 'dead', gone, 8192);
    const dUnlabelled = await snapshot(base, 'unlabelled', null, 2048);
    const dProtected = await snapshot(base, 'protected', gone, 1024);

    const r = await pruneOrphans({ base, keep: [dProtected] });

    assert.deepEqual(r.removed.map((x) => path.basename(x.dir)), ['dead']);
    assert.equal(r.freedBytes >= 8192, true);

    const exists = async (d) => !!(await fs.stat(d).catch(() => null));
    assert.equal(await exists(dDead), false, 'the orphan should be gone');
    assert.equal(await exists(dLive), true, 'a live repository index must survive');
    // "Cannot identify" is not "orphaned": deleting on that basis would throw
    // away the index of a repository that is alive and well.
    assert.equal(await exists(dUnlabelled), true, 'an unlabelled snapshot must survive');
    assert.equal(r.unlabelled, 1);
    assert.equal(await exists(dProtected), true, 'a snapshot in use must survive');

    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(live, { recursive: true, force: true });
});

test('prune reports without deleting when dryRun is set', async () => {
    const base = await scratch();
    const gone = path.join(os.tmpdir(), 'repospector-deleted-repo-2');
    const dDead = await snapshot(base, 'dead', gone, 4096);
    const r = await pruneOrphans({ base, dryRun: true });
    assert.equal(r.removed.length, 1);
    assert.ok(await fs.stat(dDead).catch(() => null), 'dryRun must not delete');
    await fs.rm(base, { recursive: true, force: true });
});

test('prune on a cache that does not exist yet is a no-op', async () => {
    const r = await pruneOrphans({ base: path.join(os.tmpdir(), 'repospector-no-such-cache-dir') });
    assert.deepEqual(r.removed, []);
    assert.equal(r.freedBytes, 0);
});

test('the size cap evicts least-recently-used first and spares what is in use', async () => {
    // Pruning orphans cannot bound growth on its own: forty live repositories
    // means forty legitimately-labelled indexes.
    const base = await scratch();
    const live = await scratch();
    // Sizes chosen so evicting the oldest ALONE clears the cap, making
    // "newer survived" unambiguous rather than a matter of byte overhead.
    const oldest = await snapshot(base, 'oldest', live, 200 * 1024);
    const newer = await snapshot(base, 'newer', live, 20 * 1024);
    const inUse = await snapshot(base, 'inuse', live, 20 * 1024);

    const ancient = new Date(1);
    await fs.utimes(path.join(oldest, 'blob.v8bin'), ancient, ancient);

    const r = await enforceSizeCap({ base, maxBytes: 100 * 1024, keep: [inUse] });

    const exists = async (d) => !!(await fs.stat(d).catch(() => null));
    assert.equal(await exists(oldest), false, 'oldest should be evicted first');
    assert.equal(await exists(inUse), true, 'the snapshot in use must never be evicted');
    assert.equal(await exists(newer), true, 'newer should survive once the cap is met');
    assert.ok(r.freedBytes >= 200 * 1024);

    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(live, { recursive: true, force: true });
});

test('a size cap of zero means unlimited and evicts nothing', async () => {
    const base = await scratch();
    const live = await scratch();
    const dir = await snapshot(base, 'a', live, 10 * 1024);
    for (const cap of [0, -1, undefined, NaN]) {
        const r = await enforceSizeCap({ base, maxBytes: cap });
        assert.deepEqual(r.evicted, [], `cap ${cap} must evict nothing`);
    }
    assert.ok(await fs.stat(dir).catch(() => null));
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(live, { recursive: true, force: true });
});

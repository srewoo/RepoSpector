import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installIndexedDb, snapshot, restore, snapshotDir } from '../src/adapters/persistence.js';

before(() => installIndexedDb());

/** Open a DB, creating one store, exactly as an extension service would. */
function openWithStore(name, store, keyPath, version = 1) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function put(db, store, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([store], 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getAll(db, store) {
    return new Promise((resolve, reject) => {
        const req = db.transaction([store], 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

test('installIndexedDb exposes a working global', () => {
    assert.equal(typeof indexedDB, 'object');
    assert.equal(typeof indexedDB.open, 'function');
});

test('snapshot then restore round-trips records identically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    const db = await openWithStore('RepoSpectorDB', 'repo_vectors', 'id');
    await put(db, 'repo_vectors', { id: 'a', vector: [0.1, 0.2], text: 'alpha' });
    await put(db, 'repo_vectors', { id: 'b', vector: [0.3, 0.4], text: 'beta' });

    const saved = await snapshot(dir);
    assert.ok(saved.records >= 2, `expected >=2 records, got ${saved.records}`);

    // Wipe the store to simulate a fresh process.
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['repo_vectors'], 'readwrite');
        tx.objectStore('repo_vectors').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    assert.equal((await getAll(db, 'repo_vectors')).length, 0);

    const loaded = await restore(dir);
    assert.ok(loaded.records >= 2);

    const rows = await getAll(db, 'repo_vectors');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.id === 'a').vector, [0.1, 0.2]);
});

test('restore into a database whose stores do not exist does not throw', async () => {
    // The ordering rule: restore runs AFTER services create their schemas. If it
    // is called too early it must degrade, not crash — a crash here would take
    // the whole server down at startup.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    fs.writeFileSync(
        path.join(dir, 'NoSuchDb.json'),
        JSON.stringify({ name: 'NoSuchDb', version: 1, stores: { ghost: [{ id: 1 }] } }),
    );
    const r = await restore(dir);
    assert.equal(typeof r.records, 'number');
});

test('restore from an empty or missing directory is a no-op, not an error', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    assert.deepEqual(await restore(empty), { databases: 0, records: 0 });
    assert.deepEqual(await restore(path.join(empty, 'nope')), { databases: 0, records: 0 });
});

test('snapshot then restore covers multiple real databases, not just RepoSpectorDB', async () => {
    // Regression guard for the seven-database requirement: a change to
    // databaseNames(), the union logic, or the per-store loop that only
    // happened to work for RepoSpectorDB must fail this test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));

    const vectorsDb = await openWithStore('RepoSpectorDB', 'repo_vectors', 'id');
    await put(vectorsDb, 'repo_vectors', { id: 'v1', vector: [1, 2], text: 'one' });

    // A second, differently-shaped real database with a different keyPath,
    // proving the per-store loop is not coupled to 'id'. Version 2: earlier
    // tests' snapshot()/restore() calls already opened this name (it is one
    // of REPOSPECTOR_DATABASES) at version 1 with no stores via openExisting,
    // so version 1 here would not fire onupgradeneeded again.
    const graphDb = await openWithStore('repospector_graph_analysis', 'graph_cache', 'repoId', 2);
    await put(graphDb, 'graph_cache', { repoId: 'repo-1', summary: 'cached analysis' });

    const saved = await snapshot(dir);
    assert.ok(saved.databases >= 2, `expected >=2 databases, got ${saved.databases}`);

    await new Promise((resolve, reject) => {
        const tx = vectorsDb.transaction(['repo_vectors'], 'readwrite');
        tx.objectStore('repo_vectors').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    await new Promise((resolve, reject) => {
        const tx = graphDb.transaction(['graph_cache'], 'readwrite');
        tx.objectStore('graph_cache').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    assert.equal((await getAll(vectorsDb, 'repo_vectors')).length, 0);
    assert.equal((await getAll(graphDb, 'graph_cache')).length, 0);

    await restore(dir);

    // RepoSpectorDB/repo_vectors is shared with the earlier round-trip test in
    // this same process (fake-indexeddb's global state persists across tests),
    // so assert presence of this test's own record rather than an exact count.
    const vectorRows = await getAll(vectorsDb, 'repo_vectors');
    const graphRows = await getAll(graphDb, 'graph_cache');
    assert.ok(vectorRows.some((r) => r.id === 'v1'), 'expected v1 to survive the round trip');
    assert.equal(graphRows.length, 1);
    assert.equal(graphRows[0].repoId, 'repo-1');
    assert.equal(graphRows[0].summary, 'cached analysis');
});

test('a Set survives a snapshot/restore round trip', async () => {
    // This is the regression test for the structured-clone defect: JSON
    // cannot represent a Set (it serializes to `{}`), which is exactly what
    // broke BM25Index's revived stopWords after a warm start. Version 2:
    // RepoSpectorBM25 is in REPOSPECTOR_DATABASES, so an earlier test's
    // snapshot()/restore() call may already have implicitly created it
    // schema-less at version 1 via openExisting.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    const db = await openWithStore('RepoSpectorBM25', 'bm25_config', 'id', 2);
    await put(db, 'bm25_config', { id: 'cfg', stopWords: new Set(['the', 'a', 'an']) });

    await snapshot(dir);
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['bm25_config'], 'readwrite');
        tx.objectStore('bm25_config').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    await restore(dir);

    const rows = await getAll(db, 'bm25_config');
    const row = rows.find((r) => r.id === 'cfg');
    assert.ok(row, 'expected the record to come back at all');
    assert.ok(row.stopWords instanceof Set, `expected stopWords to survive as a Set, got ${typeof row.stopWords}`);
    assert.deepEqual([...row.stopWords].sort(), ['a', 'an', 'the']);
});

test('a Map and a Date survive a snapshot/restore round trip', async () => {
    // Map and Date fail identically to Set under JSON.stringify (Map -> "{}",
    // Date -> a string that never gets revived back into a Date).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    const db = await openWithStore('RepoSpectorHNSW', 'hnsw_meta', 'id', 2);
    const when = new Date('2024-01-01T00:00:00.000Z');
    await put(db, 'hnsw_meta', { id: 'm1', counts: new Map([['a', 1], ['b', 2]]), builtAt: when });

    await snapshot(dir);
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['hnsw_meta'], 'readwrite');
        tx.objectStore('hnsw_meta').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    await restore(dir);

    const rows = await getAll(db, 'hnsw_meta');
    const row = rows.find((r) => r.id === 'm1');
    assert.ok(row, 'expected the record to come back at all');
    assert.ok(row.counts instanceof Map, `expected counts to survive as a Map, got ${typeof row.counts}`);
    assert.equal(row.counts.get('a'), 1);
    assert.equal(row.counts.get('b'), 2);
    assert.ok(row.builtAt instanceof Date, `expected builtAt to survive as a Date, got ${typeof row.builtAt}`);
    assert.equal(row.builtAt.getTime(), when.getTime());
});

test('restore against a path that is a file, not a directory, degrades instead of throwing', async () => {
    // fs.existsSync is true for a file, so the guard above does not catch this;
    // it is fs.readdirSync (ENOTDIR) that must be guarded.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    const filePath = path.join(dir, 'not-a-directory');
    fs.writeFileSync(filePath, 'not a directory');

    await assert.doesNotReject(async () => {
        const r = await restore(filePath);
        assert.deepEqual(r, { databases: 0, records: 0 });
    });
});

test('restore skips a corrupt/garbage snapshot file and still returns a number', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    // Garbage bytes with the real snapshot extension: v8.deserialize must
    // reject this cleanly rather than throwing out of restore().
    fs.writeFileSync(path.join(dir, 'Corrupt.v8bin'), Buffer.from([0xff, 0x00, 0x01, 0x02, 0xde, 0xad]));

    const r = await restore(dir);
    assert.equal(typeof r.databases, 'number');
    assert.equal(typeof r.records, 'number');
});

test('a stale .json snapshot from the old format is ignored, not read', async () => {
    // There is no installed base to migrate: a leftover .json file from a
    // previous build of this module must not be mistaken for a valid
    // snapshot (it can't represent a Set/Map/Date, which is the exact defect
    // the v8-serialize format fixes).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    fs.writeFileSync(
        path.join(dir, 'RepoSpectorBM25.json'),
        JSON.stringify({ name: 'RepoSpectorBM25', version: 1, stores: { bm25_config: [{ id: 'stale' }] } }),
    );

    const r = await restore(dir);
    assert.deepEqual(r, { databases: 0, records: 0 });
});

test('snapshotDir is stable for a repo path and differs between repos', () => {
    const a = snapshotDir('/base', '/work/alpha');
    assert.equal(a, snapshotDir('/base', '/work/alpha'));
    assert.notEqual(a, snapshotDir('/base', '/work/beta'));
    assert.ok(a.startsWith('/base'));
});

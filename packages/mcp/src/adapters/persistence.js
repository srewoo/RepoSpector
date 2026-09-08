import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import v8 from 'node:v8';

// `/auto` assigns indexedDB, IDBKeyRange and friends onto globalThis as a
// side effect of import, which is exactly what Database.js reaches for when
// it opens the bare global `indexedDB`. This import MUST happen before any
// extension service module is imported.
import 'fake-indexeddb/auto';

/**
 * IndexedDB in Node, with the index persisted to disk between runs.
 *
 * The extension's storage layer is IndexedDB throughout, and its in-memory
 * state is plain Maps. Rather than extracting a storage port across five
 * shipping files to serve one new consumer, this installs a shim as the global
 * and snapshots the contents. Nothing under src/services/ changes.
 *
 * ORDER MATTERS, and getting it wrong fails quietly:
 *   1. installIndexedDb()   — before importing any extension service
 *   2. let services open their databases (their upgrade handlers create stores)
 *   3. restore(dir)         — writes records into stores that now exist
 *   4. read
 * restore() cannot create schemas: object stores and keyPaths are defined
 * inside each service's own onupgradeneeded, not here. Restoring at step 1
 * throws "object store not found"; reading at step 2 returns an empty index,
 * which reads as "nothing indexed" rather than as a bug.
 */

/**
 * Every database the extension opens. Used when `indexedDB.databases()` is
 * unavailable, and as a cross-check when it is.
 *
 * Snapshotting only RepoSpectorDB would silently drop the graph, the BM25 and
 * HNSW indexes and the manifest — producing a warm index that answers nothing.
 */
export const REPOSPECTOR_DATABASES = Object.freeze([
    'RepoSpectorDB',                   // Database.js — repo_vectors, pr_sessions, …
    'repospector_knowledge_graph',     // KnowledgeGraphService
    'repospector_graph_analysis',      // GraphAnalysisCache
    'RepoSpectorBM25',                 // BM25Store
    'RepoSpectorHNSW',                 // HNSWStore
    'RepoSpectorManifests',            // IndexManifest / ManifestStore
    'repospector_learning',            // AdaptiveLearningService
]);

/**
 * Snapshot files use Node's v8 serialize()/deserialize(), which implement the
 * structured clone algorithm — the same semantics IndexedDB itself uses for
 * put()/getAll(). JSON does NOT: it cannot represent a Set, Map, Date, or
 * typed array (Set/Map serialize to `{}`; Date survives only as a string
 * that never gets revived). BM25Index's config carries a `stopWords: Set`
 * (src/services/BM25Index.js), so a JSON-based snapshot silently replaced it
 * with `{}` on every warm start, and `stopWords.has` then threw at query
 * time — a defect invisible in the browser, where IndexedDB's own structured
 * clone never lost the Set. `.v8bin` marks a file as this format explicitly,
 * so it's never confused with, or fed, the plain-JSON files an older build
 * of this module could have left on disk.
 */
const SNAPSHOT_EXT = '.v8bin';

let installed = false;

/**
 * The shim installs itself via the side-effect import above; this remains as an
 * explicit, ordered call site so the sequence in the module docstring is
 * visible at the point of use rather than implied by import order.
 */
export function installIndexedDb() {
    installed = true;
    return installed;
}

/** A stable, filesystem-safe directory for one repository's snapshot. */
export function snapshotDir(baseDir, repoPath) {
    const hash = crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 16);
    return path.join(baseDir, hash);
}

function openExisting(name) {
    return new Promise((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        // A database that has never existed opens at version 1 with no stores,
        // which getAll below simply reports as empty.
        req.onupgradeneeded = () => { /* leave schema alone */ };
    });
}

function getAll(db, store) {
    return new Promise((resolve) => {
        try {
            const req = db.transaction([store], 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        } catch {
            resolve([]);
        }
    });
}

async function databaseNames() {
    if (typeof indexedDB.databases === 'function') {
        try {
            const listed = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
            // Union: enumeration can miss a database this process has not opened.
            return [...new Set([...listed, ...REPOSPECTOR_DATABASES])];
        } catch {
            return [...REPOSPECTOR_DATABASES];
        }
    }
    return [...REPOSPECTOR_DATABASES];
}

/** Write every database's contents to `dir` as one v8-serialized file per database. */
export async function snapshot(dir) {
    fs.mkdirSync(dir, { recursive: true });
    let databases = 0;
    let records = 0;

    for (const name of await databaseNames()) {
        const db = await openExisting(name);
        if (!db) continue;
        const stores = Array.from(db.objectStoreNames);
        if (stores.length === 0) { db.close(); continue; }

        const payload = { name, version: db.version, stores: {} };
        for (const store of stores) {
            const rows = await getAll(db, store);
            payload.stores[store] = rows;
            records += rows.length;
        }
        db.close();

        fs.writeFileSync(path.join(dir, `${name}${SNAPSHOT_EXT}`), v8.serialize(payload));
        databases += 1;
    }

    return { databases, records };
}

/**
 * Load a snapshot back into stores that already exist.
 *
 * Every failure degrades rather than throwing: a snapshot from an older schema,
 * or one written before a store was renamed, must not stop the server from
 * starting. The worst outcome is an index that reports itself cold, which
 * `index_repo` can rebuild.
 */
export async function restore(dir) {
    if (!fs.existsSync(dir)) return { databases: 0, records: 0 };
    let databases = 0;
    let records = 0;

    try {
        // readdirSync throws ENOTDIR (dir is actually a file), EACCES
        // (unreadable), etc. — any of those must degrade like every other
        // failure path here, not crash the server at startup.
        //
        // Only SNAPSHOT_EXT files are treated as valid snapshots. A stale
        // `.json` file left by an older build of this module is ignored, not
        // read: it was written by the JSON format this fix replaces
        // specifically because JSON cannot round-trip a Set/Map/Date, so
        // reading it back would silently reintroduce that defect. There is no
        // installed base to migrate, so no migration path is provided.
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(SNAPSHOT_EXT));

        for (const file of files) {
            let payload;
            try {
                payload = v8.deserialize(fs.readFileSync(path.join(dir, file)));
            } catch {
                // Corrupt file, or a v8 payload written by a different Node
                // major version (the wire format is not guaranteed stable
                // across versions) — skip it, do not fail startup.
                continue;
            }
            const db = await openExisting(payload.name);
            if (!db) continue;

            for (const [store, rows] of Object.entries(payload.stores || {})) {
                if (!db.objectStoreNames.contains(store)) continue; // schema not created yet
                if (!Array.isArray(rows) || rows.length === 0) continue;
                await new Promise((resolve) => {
                    try {
                        const tx = db.transaction([store], 'readwrite');
                        const os_ = tx.objectStore(store);
                        for (const row of rows) os_.put(row);
                        tx.oncomplete = () => { records += rows.length; resolve(); };
                        tx.onerror = () => resolve();
                    } catch {
                        resolve();
                    }
                });
            }
            db.close();
            databases += 1;
        }
    } catch {
        return { databases: 0, records: 0 };
    }

    return { databases, records };
}

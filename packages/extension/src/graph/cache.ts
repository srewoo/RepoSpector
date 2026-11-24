import type { FileSymbols } from '@repospector/core';

/**
 * The saved code index, on the user's machine only. Symbols are stored per file content (git blob
 * id), so a file that did not change between commits is parsed once; each indexed commit stores its
 * list of (path, blob id). Holds symbol names and positions, never file contents.
 */
export interface SavedGraph {
  /** `<host>/<repo>@<commit sha>` */
  readonly key: string;
  readonly repo: string;
  readonly files: readonly (readonly [path: string, blob: string])[];
  readonly skipped: number;
  readonly at: number;
}

/** A parse result per blob; `null` means "parsed, nothing to keep", so it is not parsed again. */
export type BlobSymbols = FileSymbols | null;

export interface IndexCache {
  getGraph(key: string): Promise<SavedGraph | undefined>;
  /** Newest saved graph of a repository, for an incremental update. */
  latestGraph(repo: string): Promise<SavedGraph | undefined>;
  putGraph(g: SavedGraph): Promise<void>;
  getSymbols(blobs: readonly string[]): Promise<Map<string, BlobSymbols>>;
  putSymbols(entries: ReadonlyMap<string, BlobSymbols>): Promise<void>;
  /** Keeps the newest `keep` graphs and the blobs they use; deletes the rest. */
  prune(keep: number): Promise<void>;
  stats(): Promise<{ graphs: number; blobs: number }>;
  clear(): Promise<void>;
}

export const KEEP_GRAPHS = 20;

/** Git's blob id (sha1 of "blob <size>\0" + content): matches the ids the GitHub tree API lists. */
export async function gitBlobId(data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head);
  buf.set(data, head.length);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory cache: tests, and a fallback when IndexedDB is unavailable. */
export function memoryCache(): IndexCache {
  const graphs = new Map<string, SavedGraph>();
  const symbols = new Map<string, BlobSymbols>();
  return {
    getGraph: async (k) => graphs.get(k),
    latestGraph: async (repo) => [...graphs.values()].filter((g) => g.repo === repo).sort((a, b) => b.at - a.at)[0],
    putGraph: async (g) => void graphs.set(g.key, g),
    getSymbols: async (ids) => new Map(ids.filter((id) => symbols.has(id)).map((id) => [id, symbols.get(id) ?? null])),
    putSymbols: async (e) => e.forEach((v, k) => symbols.set(k, v)),
    async prune(keep) {
      const kept = [...graphs.values()].sort((a, b) => b.at - a.at).slice(0, keep);
      for (const k of [...graphs.keys()]) if (!kept.some((g) => g.key === k)) graphs.delete(k);
      const used = new Set(kept.flatMap((g) => g.files.map(([, b]) => b)));
      for (const k of [...symbols.keys()]) if (!used.has(k)) symbols.delete(k);
    },
    stats: async () => ({ graphs: graphs.size, blobs: symbols.size }),
    clear: async () => (graphs.clear(), symbols.clear()),
  };
}

const DB = 'repospector-index';
/**
 * Bump when core's parser queries change: stored symbols were extracted with the old queries and
 * would silently miss what the new ones find. The upgrade clears the saved index. A test pins
 * INDEX_QUERIES_SHA to the current queries so a query change without a bump fails.
 * v2 (2026-11-24): JS/TS private members (#name) and function-valued class fields.
 */
export const INDEX_DB_VERSION = 2;
export const INDEX_QUERIES_SHA = '98a7e90df331';
const GRAPHS = 'graphs';
const SYMBOLS = 'symbols';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** IndexedDB cache in the extension's own origin (side panel, offscreen document and workers share it). */
export function idbCache(): IndexCache {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, INDEX_DB_VERSION);
      r.onupgradeneeded = () => {
        // Any older version was built with older queries: start the index again.
        for (const name of [GRAPHS, SYMBOLS]) if (r.result.objectStoreNames.contains(name)) r.result.deleteObjectStore(name);
        r.result.createObjectStore(GRAPHS, { keyPath: 'key' }).createIndex('repo', 'repo');
        r.result.createObjectStore(SYMBOLS);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const use = async <T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    const db = await open();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  return {
    getGraph: (k) => use(async (db) => (await req(db.transaction(GRAPHS).objectStore(GRAPHS).get(k))) as SavedGraph | undefined),
    latestGraph: (repo) => use(async (db) => ((await req(db.transaction(GRAPHS).objectStore(GRAPHS).index('repo').getAll(repo))) as SavedGraph[]).sort((a, b) => b.at - a.at)[0]),
    putGraph: (g) => use(async (db) => {
      const t = db.transaction(GRAPHS, 'readwrite');
      t.objectStore(GRAPHS).put(g);
      await done(t);
    }),
    getSymbols: (ids) => use(async (db) => {
      const store = db.transaction(SYMBOLS).objectStore(SYMBOLS);
      const values = await Promise.all(ids.map((id) => req(store.get(id)) as Promise<BlobSymbols | undefined>));
      return new Map(ids.flatMap((id, i) => (values[i] === undefined ? [] : [[id, values[i] ?? null] as const])));
    }),
    putSymbols: (entries) => use(async (db) => {
      const t = db.transaction(SYMBOLS, 'readwrite');
      const s = t.objectStore(SYMBOLS);
      entries.forEach((v, k) => s.put(v, k));
      await done(t);
    }),
    prune: (keep) => use(async (db) => {
      const t = db.transaction([GRAPHS, SYMBOLS], 'readwrite');
      const graphs = (await req(t.objectStore(GRAPHS).getAll())) as SavedGraph[];
      const kept = graphs.sort((a, b) => b.at - a.at).slice(0, keep);
      for (const g of graphs.slice(keep)) t.objectStore(GRAPHS).delete(g.key);
      const used = new Set(kept.flatMap((g) => g.files.map(([, b]) => b)));
      for (const k of (await req(t.objectStore(SYMBOLS).getAllKeys())) as string[]) if (!used.has(k)) t.objectStore(SYMBOLS).delete(k);
      await done(t);
    }),
    stats: () => use(async (db) => {
      const t = db.transaction([GRAPHS, SYMBOLS]);
      return { graphs: await req(t.objectStore(GRAPHS).count()), blobs: await req(t.objectStore(SYMBOLS).count()) };
    }),
    clear: () => use(async (db) => {
      const t = db.transaction([GRAPHS, SYMBOLS], 'readwrite');
      t.objectStore(GRAPHS).clear();
      t.objectStore(SYMBOLS).clear();
      await done(t);
    }),
  };
}

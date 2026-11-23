import { parseFeedbackJsonl, type FeedbackEntry, type ReviewTarget } from '@repospector/core';
import type { RunRecord } from './engine.js';

/**
 * Run records in IndexedDB. Shared by the side panel, the offscreen document and the review worker
 * (same extension origin); none of them can use chrome.storage from the worker. Keys are never stored here.
 */
const DB = 'repospector';
const RUNS = 'runs';
const FEEDBACK = 'feedback';
const KEEP_RUNS = 50;

export const RUN_CHANNEL = 'repospector-runs';

export function targetKey(t: ReviewTarget): string {
  return t.kind === 'github' ? `${t.host}/${t.owner}/${t.repo}#${t.number}` : `${t.host}/${t.project}!${t.iid}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const runs = req.result.createObjectStore(RUNS, { keyPath: 'id' });
      runs.createIndex('target', 'targetKey');
      runs.createIndex('startedAt', 'startedAt');
      req.result.createObjectStore(FEEDBACK, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRun(run: RunRecord): Promise<void> {
  const db = await open();
  try {
    await done(db.transaction(RUNS, 'readwrite').objectStore(RUNS).put({ ...run, targetKey: targetKey(run.target) }));
  } finally {
    db.close();
  }
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  const db = await open();
  try {
    return (await done(db.transaction(RUNS).objectStore(RUNS).get(id))) as RunRecord | undefined;
  } finally {
    db.close();
  }
}

/** The newest run for a pull request, if any. */
export async function latestRunFor(target: ReviewTarget): Promise<RunRecord | undefined> {
  const db = await open();
  try {
    const all = (await done(db.transaction(RUNS).objectStore(RUNS).index('target').getAll(targetKey(target)))) as RunRecord[];
    return all.sort((a, b) => b.startedAt - a.startedAt)[0];
  } finally {
    db.close();
  }
}

/** Deletes all but the newest KEEP_RUNS runs, so stored diffs and findings stay bounded. */
export async function pruneRuns(): Promise<void> {
  const db = await open();
  try {
    const store = db.transaction(RUNS, 'readwrite').objectStore(RUNS);
    const all = (await done(store.getAll())) as RunRecord[];
    for (const r of all.sort((a, b) => b.startedAt - a.startedAt).slice(KEEP_RUNS)) store.delete(r.id);
  } finally {
    db.close();
  }
}

/** How the user reacted, as shown in the panel; stored next to the core entry it maps to. */
export type FeedbackChoice = 'useful' | 'not-useful' | 'not-relevant';

export interface FeedbackRow {
  /** The finding's fingerprint: one reaction per finding, the latest wins. */
  readonly key: string;
  readonly choice: FeedbackChoice;
  /** Repository the reaction was given in, e.g. github.com/o/r. */
  readonly repo: string;
  readonly entry: FeedbackEntry;
}

async function withFeedback<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await fn(db.transaction(FEEDBACK, mode).objectStore(FEEDBACK));
  } finally {
    db.close();
  }
}

/** Rows with a valid entry; a malformed row is skipped, never fatal. */
export async function feedbackRows(): Promise<FeedbackRow[]> {
  const rows = (await withFeedback('readonly', (s) => done(s.getAll()))) as Partial<FeedbackRow>[];
  return rows.flatMap((r) => {
    const [entry] = parseFeedbackJsonl(JSON.stringify(r.entry ?? null));
    return entry && typeof r.key === 'string' && typeof r.repo === 'string' && (r.choice === 'useful' || r.choice === 'not-useful' || r.choice === 'not-relevant') ? [{ key: r.key, choice: r.choice, repo: r.repo, entry }] : [];
  });
}

/** Team feedback for the filter; parsed and validated on read. */
export async function loadFeedback(): Promise<FeedbackEntry[]> {
  return (await feedbackRows()).map((r) => r.entry);
}

export async function putFeedback(row: FeedbackRow): Promise<void> {
  await withFeedback('readwrite', (s) => done(s.put(row)));
}

export async function deleteFeedback(key: string): Promise<void> {
  await withFeedback('readwrite', (s) => done(s.delete(key)));
}

export async function clearFeedback(): Promise<void> {
  await withFeedback('readwrite', (s) => done(s.clear()));
}

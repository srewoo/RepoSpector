import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileSymbols } from './parser.js';

/**
 * Parsed symbols per file content (git blob id), so an unchanged file is parsed once across all
 * commits. Local only: it holds derived data from repos on this machine, never sent anywhere.
 */
export class GraphStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens or creates the store. A different schemaVersion (parser or queries changed) clears it. */
  static open(path: string, schemaVersion: string): GraphStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols (blob TEXT PRIMARY KEY, json TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_seen ON symbols(seen);
      CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, files INTEGER NOT NULL, built_at INTEGER NOT NULL);
    `);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as { value: string } | undefined;
    if (row?.value !== schemaVersion) {
      db.exec('DELETE FROM symbols; DELETE FROM commits;');
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', schemaVersion);
    }
    return new GraphStore(db);
  }

  get(blob: string): FileSymbols | undefined {
    const row = this.db.prepare('SELECT json FROM symbols WHERE blob = ?').get(blob) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as FileSymbols) : undefined;
  }

  /** Blobs from the list that have not been parsed yet. */
  missing(blobs: readonly string[]): string[] {
    const has = this.db.prepare('SELECT 1 FROM symbols WHERE blob = ?');
    return blobs.filter((b) => !has.get(b));
  }

  /** Inserts in one transaction. `seen` marks blobs as in use for pruning. */
  putMany(entries: readonly { blob: string; symbols: FileSymbols }[], seen = Date.now()): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO symbols (blob, json, seen) VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const e of entries) put.run(e.blob, JSON.stringify(e.symbols), seen);
    });
  }

  /** Marks blobs as used by a commit just built, so pruning keeps them. */
  touch(blobs: readonly string[], seen = Date.now()): void {
    const upd = this.db.prepare('UPDATE symbols SET seen = ? WHERE blob = ?');
    this.transaction(() => {
      for (const b of blobs) upd.run(seen, b);
    });
  }

  isBuilt(sha: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM commits WHERE sha = ?').get(sha));
  }

  markBuilt(sha: string, files: number): void {
    this.db.prepare('INSERT OR REPLACE INTO commits (sha, files, built_at) VALUES (?, ?, ?)').run(sha, files, Date.now());
  }

  /** Removes blobs not used within maxAgeMs, and the commit records of that age. Returns blobs removed. */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const res = this.db.prepare('DELETE FROM symbols WHERE seen < ?').run(cutoff);
    this.db.prepare('DELETE FROM commits WHERE built_at < ?').run(cutoff);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

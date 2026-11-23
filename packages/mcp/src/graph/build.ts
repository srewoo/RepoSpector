import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { isIndexable, languageFor, QUERIES } from '@repospector/core';
import type { GitRepo } from '../git.js';
import { readBlobs } from './blobs.js';
import { extractSymbols, type FileSymbols } from './parser.js';
import type { GraphStore } from './store.js';

/** Changes whenever the queries or the extracted shape change, which invalidates stored symbols. */
export const GRAPH_SCHEMA = createHash('sha256').update(`extract-v2 tree-sitter-wasm-0.3.1 ${JSON.stringify(QUERIES)}`).digest('hex').slice(0, 16);

const FLUSH_EVERY = 200;
const YIELD_EVERY = 25;

export interface BuildStats {
  readonly files: number;
  readonly parsed: number;
  readonly reused: number;
  readonly ms: number;
}

/** Files the graph covers: supported language, safe path, not secret or generated, small enough to parse. */
export function graphable(path: string, size: number): boolean {
  return isIndexable(path, size); // shared with the Chrome extension's archive index
}

/** Parses every graphable file at a commit whose content is not stored yet, then marks the commit built. */
export async function buildGraph(repo: GitRepo, store: GraphStore, commit: string): Promise<BuildStats> {
  const started = Date.now();
  const entries = (await repo.lsTree(commit)).filter((e) => graphable(e.path, e.size));
  const pathOf = new Map(entries.map((e) => [e.blob, e.path]));
  const missing = new Set(store.missing([...pathOf.keys()]));
  let pending: { blob: string; symbols: FileSymbols }[] = [];
  let parsed = 0;
  for await (const [blob, content] of readBlobs(repo.root, entries.filter((e) => missing.has(e.blob) && missing.delete(e.blob)))) {
    const path = pathOf.get(blob) ?? '';
    let symbols: FileSymbols | undefined;
    try {
      symbols = await extractSymbols(path, content);
    } catch (e) {
      console.error(`[repospector] graph: could not parse ${path}:`, (e as Error).message);
    }
    // Stored even when empty, so a file that fails to parse is not retried on every build.
    pending.push({ blob, symbols: symbols ?? { language: languageFor(path) ?? 'javascript', defs: [], calls: [], inherits: [] } });
    if (++parsed % YIELD_EVERY === 0) await yieldToLoop();
    if (pending.length >= FLUSH_EVERY) {
      store.putMany(pending);
      pending = [];
    }
  }
  store.putMany(pending);
  store.touch([...pathOf.keys()]);
  store.markBuilt(commit, entries.length);
  return { files: entries.length, parsed, reused: entries.length - parsed, ms: Date.now() - started };
}

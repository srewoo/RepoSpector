import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitRepo } from '../git.js';
import { buildGraph, GRAPH_SCHEMA, type BuildStats } from './build.js';
import type { FileSymbols } from './parser.js';
import type { GraphStore } from './store.js';

const RETENTION_MS = 30 * 86_400_000;
/** Commits whose path → blob map is kept in memory. */
const TREE_CACHE = 4;

export function defaultCacheDir(): string {
  return process.env.REPOSPECTOR_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'repospector');
}

/**
 * The stored code graph for one repo: builds commits in the background, one at a time, and
 * answers "symbols in these files at this commit" once a commit is built.
 */
export class GraphService {
  private readonly builds = new Map<string, Promise<BuildStats>>();
  private readonly trees = new Map<string, Map<string, string>>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly repo: GitRepo,
    private readonly store: GraphStore,
  ) {}

  /** Undefined when the runtime has no node:sqlite (Node < 22.13); callers then parse on demand. */
  static async open(repo: GitRepo, cacheDir = defaultCacheDir()): Promise<GraphService | undefined> {
    try {
      const { GraphStore } = await import('./store.js');
      const name = createHash('sha256').update(repo.root).digest('hex').slice(0, 16);
      const store = GraphStore.open(join(cacheDir, `graph-${name}.sqlite`), GRAPH_SCHEMA);
      store.prune(RETENTION_MS);
      return new GraphService(repo, store);
    } catch (e) {
      console.error('[repospector] code graph disabled:', (e as Error).message);
      return undefined;
    }
  }

  /** Starts (or joins) the build of a commit. Builds run one after another. */
  ensure(commit: string): Promise<BuildStats> {
    let build = this.builds.get(commit);
    if (!build) {
      build = this.queue.then(() => buildGraph(this.repo, this.store, commit));
      this.queue = build.catch(() => undefined);
      this.builds.set(commit, build);
      build.then(
        (s) => console.error(`[repospector] graph ${commit.slice(0, 8)}: ${s.files} files, ${s.parsed} parsed, ${s.reused} reused, ${s.ms} ms`),
        (e: unknown) => {
          this.builds.delete(commit);
          console.error('[repospector] graph build failed:', (e as Error).message);
        },
      );
    }
    return build;
  }

  /**
   * Stored symbols for paths at a commit, waiting up to waitMs for its build. Undefined if the
   * commit is not built in time; paths not in the graph are absent from the map.
   */
  async symbolsAt(commit: string, paths: readonly string[], waitMs: number): Promise<Map<string, FileSymbols> | undefined> {
    if (!this.store.isBuilt(commit)) {
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(resolve, waitMs, 'timeout').unref());
      if ((await Promise.race([this.ensure(commit).catch(() => 'timeout' as const), timeout])) === 'timeout') return undefined;
    }
    const tree = await this.tree(commit);
    const out = new Map<string, FileSymbols>();
    for (const p of paths) {
      const blob = tree.get(p);
      const symbols = blob ? this.store.get(blob) : undefined;
      if (symbols) out.set(p, symbols);
    }
    return out;
  }

  /** Symbols of every indexed file at a commit (for the extension's local mode); builds it first if needed. */
  async allSymbolsAt(commit: string, waitMs: number): Promise<Map<string, FileSymbols> | undefined> {
    return this.symbolsAt(commit, [...(await this.tree(commit)).keys()], waitMs);
  }

  close(): void {
    this.store.close();
  }

  private async tree(commit: string): Promise<Map<string, string>> {
    let t = this.trees.get(commit);
    if (!t) {
      t = new Map((await this.repo.lsTree(commit)).map((e) => [e.path, e.blob]));
      this.trees.set(commit, t);
      if (this.trees.size > TREE_CACHE) this.trees.delete(this.trees.keys().next().value ?? '');
    }
    return t;
  }
}

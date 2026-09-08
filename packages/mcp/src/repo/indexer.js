import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { installIndexedDb, snapshot, restore, snapshotDir } from '../adapters/persistence.js';
import { createNodeParser } from '../adapters/treeSitter.js';
import { createNodeEmbedder } from '../adapters/embedder.js';
import { readRepoFiles } from './source.js';
import { recordRepoPath, labelIfMissing, INDEX_BASE_DIR } from './cache.js';

// The shim must be installed before any extension service is imported, because
// Database.js reaches for the bare global `indexedDB`.
installIndexedDb();

// RAGService.js has a couple of relative imports with no `.js` suffix (built
// for webpack, which resolves those; Node's native ESM resolver does not).
// This registers a narrow resolution fallback before that module graph loads
// — see esmInterop.loader.js for why it lives here rather than as an edit to
// src/services/RAGService.js.
//
// register() installs the hook PROCESS-WIDE, not just for the import below:
// once registered, every subsequent module resolution anywhere in this
// process (any file, any later import) passes through it first. It only acts
// on a specifier that (a) is relative and (b) has no extension and (c) the
// default resolver already failed on, so a genuine typo/missing-module import
// still fails, just with a slightly different error message. Noted here,
// not only inside esmInterop.loader.js, because the next person debugging an
// unexpected resolution somewhere else in this process will look at the call
// site, not the hook's own file.
//
// esbuild resolves those same extensionless specifiers at build time, so a
// bundled dist/index.js has no need of this hook — and the relative path
// below no longer points at a real file once this module is inlined into
// dist/. Only register the hook when the loader file actually exists next
// to this one (true for src/, false once bundled).
const loaderUrl = new URL('../adapters/esmInterop.loader.js', import.meta.url);
if (existsSync(fileURLToPath(loaderUrl))) {
    register('../adapters/esmInterop.loader.js', import.meta.url);
}

const { RAGService } = await import('../../../../src/services/RAGService.js');
const { CodeGraphPipeline } = await import('../../../../src/services/CodeGraphPipeline.js');

/**
 * Owns the index lifecycle for one repository: RAG, graph, and the on-disk
 * snapshot that makes a warm start possible.
 *
 * Created lazily. An MCP client spawns every configured server at launch, so a
 * server that indexes on boot pins a core for a user who may never call it.
 */
export function createIndexer(config) {
    const repoId = path.basename(config.repo);
    const dir = snapshotDir(INDEX_BASE_DIR, config.repo);

    const embedder = createNodeEmbedder();
    const parser = createNodeParser();
    const rag = new RAGService({ provider: 'local', embeddingService: embedder });
    const pipeline = new CodeGraphPipeline({ offscreenParser: parser });

    let ready = null;
    let lastBuild = null;
    // Parser that built the graph now loaded. See recordParserMode.
    let builtParserMode = null;

    /**
     * Open every database that `restore()`/`snapshot()` will touch, BEFORE
     * either of them runs.
     *
     * persistence.js documents the restore() half of this constraint:
     * restore() cannot create schemas, only the owning service's own
     * onupgradeneeded can, so restoring before a service has opened its
     * database writes into stores that do not exist yet.
     *
     * snapshot() has the identical constraint and nothing else documents it,
     * which is the hazard this function exists to close. `openExisting()` in
     * persistence.js calls `indexedDB.open(name)` with NO version argument.
     * Per spec that call CREATES a missing database at version 1 with an
     * empty schema. Five of the seven RepoSpector services open their own
     * database at an explicit version 1 — KnowledgeGraphService,
     * GraphAnalysisCache, BM25Store, HNSWStore and ManifestStore
     * (IndexManifest's store). If snapshot() OR restore() reaches any of
     * those five before the owning service has opened it, `openExisting`
     * materialises that database schema-less at version 1; the service's own
     * later `indexedDB.open(name, 1)` then sees a database already at
     * version 1, so `onupgradeneeded` never fires, the object stores are
     * never created, and every write after that silently persists nothing —
     * the process reports a warm index that answers no query.
     *
     * `rag.init()` only opens RepoSpectorDB (via VectorStore, version 4 — not
     * one of the five, and not at risk). It does NOT open BM25Store,
     * HNSWStore or ManifestStore; those are reached lazily, inside
     * `indexRepositoryIncremental`, well after `restore()` would already have
     * run. Likewise `pipeline.hasGraph()`/`loadGraph()` open
     * KnowledgeGraphService lazily, and GraphAnalysisCache is opened lazily by
     * its own `get`/`set`. So this function reaches into each service and
     * calls (or triggers) its own `init()`/`_open()` directly, using each
     * service's real object identity (`rag.hybridSearcher.bm25Store`,
     * `rag.vectorStore.hnswStore`, `rag.manifestStore`, `pipeline.graph`,
     * `pipeline.analysisCache`) so the exact instance restore()/snapshot()
     * will later read from is the one whose schema gets created here. Every
     * one of these init calls is idempotent (each guards on `this.db`), so
     * calling them again later — as the normal build path does anyway — is a
     * no-op.
     */
    async function openAllSchemas() {
        await Promise.all([
            rag.hybridSearcher.bm25Store.init(),
            rag.vectorStore.hnswStore.init(),
            rag.manifestStore.init(),
            pipeline.graph.init(),
            pipeline.analysisCache.get(repoId), // forces GraphAnalysisCache._open()
        ]);
    }

    /**
     * Make the index usable, building it if needed.
     *
     * Ordering:
     *   1. rag.init()        — loads the embedding model, opens RepoSpectorDB
     *   2. openAllSchemas()  — opens the five version-1 databases (see above)
     *   3. restore(dir)      — now every store restore() can touch exists
     *   4. read / build
     *   5. snapshot(dir)     — only reached after step 2, so it is safe too
     *
     * Restoring before step 2 throws "object store not found" for whichever
     * of the five hasn't opened yet; reading before restoring returns an
     * empty index that looks like "nothing is indexed" rather than a bug.
     */
    /**
     * Which parser built the persisted graph.
     *
     * `parser.available` only turns true once `preloadFromFiles` has run, so it
     * describes THIS process, not the graph. On a warm start nothing is parsed —
     * the graph is restored — so reading it there reported `regex-fallback` for
     * a graph tree-sitter had actually built, telling the reviewing model the
     * symbols were low-fidelity when they were not. Record the mode with the
     * snapshot and report that instead.
     */
    const parserModeFile = path.join(dir, 'parser-mode.txt');

    async function recordParserMode(mode) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(parserModeFile, mode, 'utf8');
    }

    async function readParserMode() {
        try {
            const mode = (await fs.readFile(parserModeFile, 'utf8')).trim();
            return mode === 'tree-sitter' || mode === 'regex-fallback' ? mode : null;
        } catch {
            return null; // No record: a graph from before this was tracked.
        }
    }

    async function ensureIndexed({ force = false, maxFiles = config.maxFiles, onProgress } = {}) {
        if (ready && !force) return ready;

        ready = (async () => {
            await rag.init();                      // model + RepoSpectorDB
            await openAllSchemas();                 // the five version-1 stores
            await restore(dir);                     // now every store exists

            const warm = !force && await pipeline.hasGraph(repoId).catch(() => false);
            if (warm) {
                await pipeline.loadGraph(repoId);
                builtParserMode = await readParserMode();
                // A snapshot written before labelling existed cannot be
                // identified from its hash; label it now so a later prune can
                // tell whether its repository is still there.
                await labelIfMissing(dir, config.repo);
                return { built: false, repoId };
            }

            const { files, skipped, truncated } = await readRepoFiles(config.repo, { maxFiles });
            const ragResult = await rag.indexRepositoryIncremental(repoId, files, onProgress, { force });
            const graphStats = await pipeline.buildGraph(repoId, files, onProgress);
            await snapshot(dir);

            // Read AFTER buildGraph: preloadFromFiles runs during the build.
            builtParserMode = parser.available ? 'tree-sitter' : 'regex-fallback';
            await recordParserMode(builtParserMode);
            await recordRepoPath(dir, config.repo);

            lastBuild = {
                built: true,
                repoId,
                files: files.length,
                skipped,
                truncated,
                rag: ragResult,
                graph: graphStats,
                parser: builtParserMode,
            };
            return lastBuild;
        })();

        return ready;
    }

    return {
        repoId,
        rag,
        pipeline,
        ensureIndexed,
        snapshotPath: dir,
        lastBuild: () => lastBuild,
        stats: () => pipeline.getStats(),
        parserMode: () => builtParserMode
            || (parser.available ? 'tree-sitter' : 'unknown'),
    };
}

/** One indexer per process, created on first use. */
export async function getIndexer(ctx, repo) {
    const target = repo || ctx.config.repo;

    // Keyed by path, not a single slot: tools accept a per-call `repo`, so one
    // server process can hold indexes for several repositories at once. A
    // single `ctx.indexer` would hand the first repo's graph to every later
    // call for a different one — wrong answers, not an error.
    if (!ctx.indexers) ctx.indexers = new Map();
    if (!ctx.indexers.has(target)) {
        ctx.indexers.set(target, createIndexer({ ...ctx.config, repo: target }));
    }

    const indexer = ctx.indexers.get(target);
    // Kept for callers and tests that still read ctx.indexer directly.
    ctx.indexer = indexer;
    return indexer;
}

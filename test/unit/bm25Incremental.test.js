const { HybridSearcher } = require('../../src/services/HybridSearcher.js');
const { BM25Index } = require('../../src/services/BM25Index.js');
const { RAGService } = require('../../src/services/RAGService.js');
const { IndexManifest } = require('../../src/services/IndexManifest.js');

describe('ensureBM25For', () => {
    const persisted = new BM25Index();
    persisted.addDocument('a:1', 'function alpha() {}', {});
    persisted.addDocument('a:2', 'function beta() {}', {});

    const makeSearcher = () => {
        const s = new HybridSearcher({});
        s.bm25Store = { load: jest.fn(async (id) => (id === 'o/a' ? BM25Index.fromJSON(persisted.toJSON()) : null)), save: jest.fn(async () => {}) };
        return s;
    };

    it('loads the persisted index when memory is empty', async () => {
        const s = makeSearcher();
        await s.ensureBM25For('o/a');
        expect(s.bm25Index.getStats().totalDocuments).toBe(2);
        expect(s.bm25RepoId).toBe('o/a');
    });

    it('swaps indexes when a different repo is requested', async () => {
        const s = makeSearcher();
        await s.ensureBM25For('o/a');
        await s.ensureBM25For('o/b');
        expect(s.bm25Index.getStats().totalDocuments).toBe(0);
        expect(s.bm25RepoId).toBe('o/b');
    });

    it('incremental add on top of a loaded index keeps the old docs', async () => {
        const s = makeSearcher();
        await s.ensureBM25For('o/a');
        s.bm25Index.addDocument('a:3', 'function gamma() {}', {});
        await s.saveBM25ToStorage('o/a');
        const saved = s.bm25Store.save.mock.calls[0][1];
        expect(saved.getStats().totalDocuments).toBe(3);
    });

    it('does not mark repoId authoritative when the storage load errors, and reports errored:true', async () => {
        const s = new HybridSearcher({});
        s.bm25Store = { load: jest.fn(async () => { throw new Error('IndexedDB unavailable'); }), save: jest.fn(async () => {}) };
        const status = await s.ensureBM25For('o/a');
        expect(status).toEqual({ loaded: false, errored: true });
        expect(s.bm25RepoId).not.toBe('o/a');
    });

    /**
     * The interleave that ownership-by-document-count got wrong.
     *
     * indexRepository declares the fresh EMPTY index authoritative via
     * clear(repoId) and only then starts adding batches. A search arriving in
     * that window (autoIndexOwnRepo's non-blocking mode does exactly this)
     * must NOT go back to storage: doing so pulled in the pre-index snapshot,
     * and the unconditional saveBM25ToStorage at the end of the run then
     * persisted stale ∪ new — resurrecting the very chunk ids the re-index
     * exists to remove.
     */
    it('does not reload from storage for a declared-fresh index that is still empty', async () => {
        const s = makeSearcher();
        s.clear('o/a');
        const status = await s.ensureBM25For('o/a');
        expect(s.bm25Store.load).not.toHaveBeenCalled();
        expect(s.bm25Index.getStats().totalDocuments).toBe(0);
        expect(status).toEqual({ loaded: false, errored: false });
    });

    it('what a full re-index persists holds no pre-index chunks, even with a search in the empty window', async () => {
        const s = makeSearcher();
        s.clear('o/a');                                                // indexRepository step 1
        await s.ensureBM25For('o/a');                                  // concurrent search(), before batch 1
        s.bm25Index.addDocument('a:fresh', 'function delta() {}', {});  // batch 1
        s.bm25Index.addDocument('a:fresh2', 'function eps() {}', {});   // batch 2
        await s.saveBM25ToStorage('o/a');                              // indexRepository step 5
        const saved = s.bm25Store.save.mock.calls[0][1];
        expect(saved.getDocument('a:1')).toBeFalsy();
        expect(saved.getDocument('a:2')).toBeFalsy();
        expect(saved.getStats().totalDocuments).toBe(2);
    });

    it('clear() with no repoId drops ownership, so the next ensure reloads', async () => {
        const s = makeSearcher();
        await s.ensureBM25For('o/a');
        expect(s.bm25Index.getStats().totalDocuments).toBe(2);
        s.clear();                                  // thrown away, nothing declared
        await s.ensureBM25For('o/a');
        expect(s.bm25Store.load).toHaveBeenCalledTimes(2);
        expect(s.bm25Index.getStats().totalDocuments).toBe(2);
    });

    it('reports {loaded:false, errored:false} for a genuinely first-ever repo (no stored index yet)', async () => {
        const s = new HybridSearcher({});
        s.bm25Store = { load: jest.fn(async () => null), save: jest.fn(async () => {}) };
        const status = await s.ensureBM25For('o/new');
        expect(status).toEqual({ loaded: false, errored: false });
        expect(s.bm25RepoId).toBe('o/new');
    });
});

/**
 * Coverage for the two Important review findings on round 1:
 * (1) deletions must be applied to the LOADED index, not a fresh empty one,
 *     or the delta-add-then-save resurrects the deleted chunks; and
 * (2) an errored storage load must never be followed by a save, or a
 *     transient IndexedDB failure silently truncates the stored index.
 * These exercise the real RAGService.indexRepositoryIncremental with only
 * the manifest/vector store and BM25 storage stubbed.
 */
describe('indexRepositoryIncremental BM25 handling', () => {
    const repoId = 'o/a';

    function makeManifestWithTwoFiles() {
        const manifest = new IndexManifest(repoId);
        manifest.addFile('keep.js', 'function keep() {}', [`${repoId}:keep.js:0`], {});
        manifest.addFile('gone.js', 'function gone() {}', [`${repoId}:gone.js:0`], {});
        return manifest;
    }

    function makeService(bm25StoreOverrides = {}) {
        const svc = new RAGService({ provider: 'local', embeddingService: { init: async () => {} } });
        svc.init = async () => {};
        svc.vectorStore = {
            isIndexed: jest.fn(async () => true),
            deleteChunks: jest.fn(async () => {}),
            addVectors: jest.fn(async () => {}),
        };
        svc.hybridSearcher.setVectorStore(svc.vectorStore);
        svc.manifestStore = { load: jest.fn(async () => makeManifestWithTwoFiles()), save: jest.fn(async () => {}) };
        svc.hybridSearcher.bm25Store = {
            load: jest.fn(async () => null),
            save: jest.fn(async () => {}),
            ...bm25StoreOverrides,
        };
        return svc;
    }

    it('a deletion applied after a restart is absent from what gets persisted', async () => {
        const persisted = new BM25Index();
        persisted.addDocument(`${repoId}:keep.js:0`, 'function keep() {}', {});
        persisted.addDocument(`${repoId}:gone.js:0`, 'function gone() {}', {});

        const svc = makeService({
            load: jest.fn(async (id) => (id === repoId ? BM25Index.fromJSON(persisted.toJSON()) : null)),
        });

        // Only keep.js survives — gone.js is removed, driving comparison.toRemove.
        await svc.indexRepositoryIncremental(repoId, [{ path: 'keep.js', content: 'function keep() {}' }], null, {});

        expect(svc.hybridSearcher.bm25Store.save).toHaveBeenCalled();
        const saved = svc.hybridSearcher.bm25Store.save.mock.calls[0][1];
        expect(saved.getDocument(`${repoId}:gone.js:0`)).toBeFalsy();
        expect(saved.getDocument(`${repoId}:keep.js:0`)).toBeTruthy();
    });

    it('skips saveBM25ToStorage when the storage load errored, leaving the stored index untouched', async () => {
        const svc = makeService({
            load: jest.fn(async () => { throw new Error('IndexedDB unavailable'); }),
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await svc.indexRepositoryIncremental(repoId, [{ path: 'keep.js', content: 'function keep() {}' }], null, {});

        expect(svc.hybridSearcher.bm25Store.save).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping save'));
        warnSpy.mockRestore();
    });
});

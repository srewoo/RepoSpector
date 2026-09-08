/**
 * The bug these tests pin: hybrid search returned chunks with
 * `filePath: undefined`, because BM25 is indexed with `chunk.metadata` and that
 * object never carried the path. Snippets reached the model labelled
 * `// File: unknown`, and `deduplicateResults` — which buckets by path — put
 * every chunk in one `'unknown'` bucket, turning `maxChunksPerFile` into a hard
 * cap on the whole result set.
 */
const { filePathFromChunkId, resolveChunkFilePath } = require('../../src/utils/chunkId.js');

describe('filePathFromChunkId', () => {
    test('recovers the path from an id RAGService minted', () => {
        expect(filePathFromChunkId('mini-repo:src/auth.js:0', 'mini-repo')).toBe('src/auth.js');
    });

    test('handles the owner/repo form of repoId', () => {
        expect(filePathFromChunkId('acme/widgets:src/a/b.js:12', 'acme/widgets')).toBe('src/a/b.js');
    });

    test('a double-digit chunk index is not mistaken for part of the path', () => {
        expect(filePathFromChunkId('r:src/x.js:107', 'r')).toBe('src/x.js');
    });

    test('without a repoId, the first segment is assumed to be it', () => {
        expect(filePathFromChunkId('mini-repo:src/auth.js:3')).toBe('src/auth.js');
    });

    test('a path containing a colon survives when repoId anchors the parse', () => {
        expect(filePathFromChunkId('r:src/a:b.js:1', 'r')).toBe('src/a:b.js');
    });

    test('returns null when the id belongs to a different repo', () => {
        // Guards against attributing one repo's chunk to another.
        expect(filePathFromChunkId('other-repo:src/auth.js:0', 'mini-repo')).toBeNull();
    });

    test('returns null for anything that is not a chunk id', () => {
        for (const bad of [undefined, null, '', 42, {}, 'no-colons', 'repo:src/auth.js']) {
            expect(filePathFromChunkId(bad, 'repo')).toBeNull();
        }
    });
});

describe('resolveChunkFilePath', () => {
    test('prefers the explicit field', () => {
        const r = { filePath: 'real.js', metadata: { filePath: 'meta.js' }, docId: 'r:id.js:0' };
        expect(resolveChunkFilePath(r, 'r')).toBe('real.js');
    });

    test('falls back to metadata when the field is absent', () => {
        expect(resolveChunkFilePath({ metadata: { filePath: 'meta.js' } }, 'r')).toBe('meta.js');
    });

    test('falls back to the id — the case that fixes already-persisted indexes', () => {
        // A BM25 hit from an index built before metadata carried the path.
        const hit = { docId: 'mini-repo:src/auth.js:0', metadata: { tokens: 48, type: 'code' } };
        expect(resolveChunkFilePath(hit, 'mini-repo')).toBe('src/auth.js');
    });

    test('reads `id` when the hit has no `docId`', () => {
        expect(resolveChunkFilePath({ id: 'r:src/s.js:2' }, 'r')).toBe('src/s.js');
    });

    test('returns null rather than a misleading placeholder', () => {
        expect(resolveChunkFilePath({ metadata: {} }, 'r')).toBeNull();
        expect(resolveChunkFilePath(null, 'r')).toBeNull();
    });
});

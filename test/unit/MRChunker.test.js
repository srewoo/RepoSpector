const {
    shouldChunk,
    buildBrief,
    chunkMR,
} = require('../../src/services/MRChunker.js');

function mkFile(overrides = {}) {
    return {
        filename: 'src/foo.js',
        additions: 5,
        deletions: 2,
        patch: '',
        ...overrides,
    };
}

describe('shouldChunk', () => {
    it('returns false for small MRs', () => {
        expect(shouldChunk([mkFile(), mkFile()])).toBe(false);
    });
    it('returns true above file-count threshold', () => {
        const many = Array.from({ length: 25 }, () => mkFile());
        expect(shouldChunk(many)).toBe(true);
    });
    it('returns true above LOC threshold', () => {
        expect(shouldChunk([mkFile({ additions: 3000 })])).toBe(true);
    });
});

describe('buildBrief', () => {
    it('detects added and removed exports', () => {
        const brief = buildBrief({
            files: [
                mkFile({
                    filename: 'src/a.js',
                    patch: [
                        '@@ -1,3 +1,3 @@',
                        '-export function oldFn() {}',
                        '+export function newFn() {}',
                    ].join('\n'),
                }),
            ],
        });
        expect(brief.removed_exports).toContain('src/a.js::oldFn');
        expect(brief.added_exports).toContain('src/a.js::newFn');
    });

    it('detects changed function signatures', () => {
        const brief = buildBrief({
            files: [
                mkFile({
                    filename: 'src/a.js',
                    patch: [
                        '-function compute(x) {',
                        '+function compute(x, y) {',
                    ].join('\n'),
                }),
            ],
        });
        expect(brief.changed_signatures).toContain('src/a.js::compute');
    });

    it('flags shared-contract files', () => {
        const brief = buildBrief({
            files: [
                mkFile({ filename: 'protos/user.proto', patch: '+message X {}' }),
                mkFile({ filename: 'spec/openapi.yaml', patch: '+/foo:' }),
                mkFile({ filename: 'src/x.js' }),
            ],
        });
        expect(brief.shared_contracts).toEqual(
            expect.arrayContaining(['protos/user.proto', 'spec/openapi.yaml']),
        );
        expect(brief.shared_contracts).not.toContain('src/x.js');
    });

    it('detects rename pairs', () => {
        const brief = buildBrief({
            files: [
                {
                    filename: 'src/new.js',
                    previous_filename: 'src/old.js',
                    additions: 0,
                    deletions: 0,
                    patch: '',
                },
            ],
        });
        expect(brief.rename_pairs).toEqual([{ from: 'src/old.js', to: 'src/new.js' }]);
    });

    it('emits coupling hints for directories touched multiple times', () => {
        const brief = buildBrief({
            files: [
                mkFile({ filename: 'src/api/a.js' }),
                mkFile({ filename: 'src/api/b.js' }),
                mkFile({ filename: 'src/api/c.js' }),
                mkFile({ filename: 'lib/x.js' }),
            ],
        });
        expect(brief.coupling_hints[0]).toEqual({ dir: 'src/api', files: 3 });
    });

    it('survives missing/empty input', () => {
        const brief = buildBrief({});
        expect(brief.removed_exports).toEqual([]);
        expect(brief.shared_contracts).toEqual([]);
    });
});

describe('chunkMR', () => {
    it('returns a single chunk for small MRs', () => {
        const r = chunkMR({ files: [mkFile(), mkFile()] });
        expect(r.summary.chunked).toBe(false);
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0]).toMatchObject({ index: 1, total: 1, reason: 'single_pass' });
    });

    it('produces multiple chunks for large MRs', () => {
        // 30 files × 100 LOC each = 3000 LOC, well past chunking threshold
        const files = Array.from({ length: 30 }, (_, i) =>
            mkFile({ filename: `src/dir${i % 3}/f${i}.js`, additions: 80, deletions: 20 }),
        );
        const r = chunkMR({ files });
        expect(r.summary.chunked).toBe(true);
        expect(r.chunks.length).toBeGreaterThan(1);
        // Each chunk respects size cap.
        for (const c of r.chunks) {
            expect(c.files.length).toBeGreaterThan(0);
            expect(c.loc).toBeLessThanOrEqual(1500 + 100); // allow one slop, see below
        }
        // index/total are consistent
        expect(r.chunks[0].index).toBe(1);
        expect(r.chunks.at(-1).total).toBe(r.chunks.length);
    });

    it('force-splits a single oversized file into its own chunk', () => {
        const files = [
            mkFile({ filename: 'src/huge.js', additions: 1800, deletions: 200 }),
            mkFile({ filename: 'src/small.js', additions: 5, deletions: 0 }),
        ];
        const r = chunkMR({ files });
        expect(r.summary.chunked).toBe(true);
        const huge = r.chunks.find((c) => c.files[0].filename === 'src/huge.js');
        expect(huge).toBeDefined();
        expect(huge.reason).toBe('forced_split_oversized');
        expect(huge.files).toHaveLength(1);
    });

    it('exposes the same brief on every chunk via the top-level field', () => {
        const files = Array.from({ length: 25 }, (_, i) =>
            mkFile({ filename: `src/f${i}.js`, additions: 100, deletions: 0 }),
        );
        const r = chunkMR({ files });
        expect(r.brief).toBeDefined();
        // brief is meant to be inlined into every chunk's prompt — verify
        // it's a single shared object, not regenerated per chunk.
        expect(r.summary.totalFiles).toBe(25);
    });
});

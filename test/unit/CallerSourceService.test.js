const {
    CallerSourceService,
    locateInChunks,
    windowAround,
} = require('../../src/services/CallerSourceService.js');

/** Graph double: callers keyed by symbol. */
function fakePipeline(callersBySymbol) {
    return {
        getCallerRefs: jest.fn((symbol, limit) =>
            (callersBySymbol[symbol] || []).slice(0, limit)),
    };
}

/** Vector-store double that records how many index passes were made. */
function fakeStore(chunksByFile) {
    const calls = [];
    return {
        calls,
        getChunksForFiles: jest.fn(async (repoId, paths) => {
            calls.push(paths);
            const out = new Map();
            for (const p of paths) {
                if (chunksByFile[p]) out.set(p, chunksByFile[p]);
            }
            return out;
        }),
    };
}

const UPLOAD_SRC = `import { save } from './db';

export function handleUpload(file) {
    const result = save(file);
    return result.id;
}
`;

describe('locateInChunks', () => {
    const chunks = [
        { chunkIndex: 0, content: 'const a = 1;\n' },
        { chunkIndex: 1, content: UPLOAD_SRC },
    ];

    it('picks the chunk where the symbol is declared, not the first one', () => {
        const out = locateInChunks(chunks, 'handleUpload');
        expect(out.content).toBe(UPLOAD_SRC);
        expect(UPLOAD_SRC.split('\n')[out.lineIndex]).toContain('function handleUpload');
    });

    it.each([
        ['python', 'def process(x):\n    pass\n', 'process'],
        ['go', 'func (s *Server) Handle(w http.ResponseWriter) {\n}\n', 'Handle'],
        ['arrow fn', 'const doWork = async (x) => {\n  return x;\n}\n', 'doWork'],
        ['class', 'export class Uploader {\n}\n', 'Uploader'],
    ])('finds a %s declaration', (_lang, src, name) => {
        const out = locateInChunks([{ chunkIndex: 0, content: src }], name);
        expect(out).not.toBeNull();
        expect(src.split('\n')[out.lineIndex]).toContain(name);
    });

    it('falls back to a plain mention when no declaration matches', () => {
        const src = 'someObject.handleUpload(file);\n';
        const out = locateInChunks([{ chunkIndex: 0, content: src }], 'handleUpload');
        expect(out.lineIndex).toBe(0);
    });

    it('falls back to the first chunk rather than returning nothing', () => {
        const out = locateInChunks([{ chunkIndex: 0, content: 'unrelated\n' }], 'missingSym');
        expect(out.content).toBe('unrelated\n');
    });

    it('returns null for no chunks', () => {
        expect(locateInChunks([], 'x')).toBeNull();
        expect(locateInChunks(undefined, 'x')).toBeNull();
    });

    it('does not treat a regex-special name as a pattern', () => {
        const src = 'function a$b(x) {}\n';
        expect(() => locateInChunks([{ chunkIndex: 0, content: src }], 'a$b')).not.toThrow();
    });
});

describe('windowAround', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');

    it('returns the whole thing when it already fits', () => {
        expect(windowAround('a\nb', 0, 40)).toEqual({ text: 'a\nb', offset: 0 });
    });

    it('keeps the window to the requested size plus a truncation marker', () => {
        const out = windowAround(lines, 100, 40).text.split('\n');
        expect(out).toHaveLength(41);
        expect(out[out.length - 1]).toContain('truncated');
    });

    it('shows the body after the declaration, not just the lines before it', () => {
        // What breaks a caller is how it USES the changed symbol, which is
        // below the signature — so the window is biased downward.
        const out = windowAround(lines, 100, 40).text;
        expect(out).toContain('line100');
        expect(out).toContain('line120');
        expect(out).not.toContain('line50');
    });

    it('reports the window offset so an absolute line number can be recovered', () => {
        // The window opens 4 lines above the declaration (min(4, maxLines/4)),
        // biased downward so the body that uses the changed symbol is visible.
        const { offset, text } = windowAround(lines, 100, 40);
        expect(offset).toBe(96);
        expect(text.split('\n')[0]).toBe('line96');
    });

    it('does not run off the start of the file', () => {
        expect(windowAround(lines, 0, 40).text).toContain('line0');
    });
});

describe('CallerSourceService.build', () => {
    const repoId = 'gh:acme/widgets';
    const chunksByFile = { 'src/api/upload.js': [{ chunkIndex: 0, content: UPLOAD_SRC }] };
    const callers = {
        save: [{ name: 'handleUpload', filePath: 'src/api/upload.js', startLine: 3, confidence: 0.92 }],
    };

    it('inlines the caller\'s actual source, not just its name', async () => {
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: fakeStore(chunksByFile),
        });
        const out = await svc.build(['save'], repoId, { perSymbol: 3, maxLines: 40 });

        expect(out.bySymbol.save).toContain('handleUpload');
        expect(out.bySymbol.save).toContain('const result = save(file);');
        expect(out.bySymbol.save).toContain('src/api/upload.js');
        expect(out.bySymbol.save).toContain('92% confidence');
        expect(out.stats.callers).toBe(1);
    });

    it('loads every needed file in a single index pass', async () => {
        // The store is indexed by repo, so one read per caller would rescan
        // every chunk in the repository each time.
        const store = fakeStore({
            'a.js': [{ chunkIndex: 0, content: 'function one() { target(); }' }],
            'b.js': [{ chunkIndex: 0, content: 'function two() { target(); }' }],
        });
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline({
                target: [
                    { name: 'one', filePath: 'a.js', confidence: 0.9 },
                    { name: 'two', filePath: 'b.js', confidence: 0.8 },
                ],
            }),
            vectorStore: store,
        });
        await svc.build(['target'], repoId, { perSymbol: 3 });

        expect(store.getChunksForFiles).toHaveBeenCalledTimes(1);
        expect(store.calls[0].sort()).toEqual(['a.js', 'b.js']);
    });

    it('skips callers that are already in the diff', async () => {
        // Budget spent on a file the model can already see displaces one it cannot.
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: fakeStore(chunksByFile),
        });
        const out = await svc.build(['save'], repoId, {
            perSymbol: 3,
            excludeFiles: new Set(['src/api/upload.js']),
        });
        expect(out.bySymbol.save).toBeUndefined();
        expect(out.stats.callers).toBe(0);
    });

    it('respects the per-symbol budget', async () => {
        const many = Array.from({ length: 10 }, (_, i) => ({
            name: `caller${i}`, filePath: `f${i}.js`, confidence: 0.5,
        }));
        const files = Object.fromEntries(
            many.map(c => [c.filePath, [{ chunkIndex: 0, content: `function ${c.name}() {}` }]]),
        );
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline({ target: many }),
            vectorStore: fakeStore(files),
        });
        const out = await svc.build(['target'], repoId, { perSymbol: 2 });
        expect(out.stats.callers).toBe(2);
    });

    it('caps the total across symbols so the prompt cannot balloon', async () => {
        const mk = (prefix) => Array.from({ length: 8 }, (_, i) => ({
            name: `${prefix}${i}`, filePath: `${prefix}${i}.js`, confidence: 0.5,
        }));
        const symbols = ['a', 'b', 'c', 'd'];
        const bySymbol = Object.fromEntries(symbols.map(s => [s, mk(s)]));
        const files = {};
        for (const list of Object.values(bySymbol)) {
            for (const c of list) files[c.filePath] = [{ chunkIndex: 0, content: `function ${c.name}() {}` }];
        }
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(bySymbol),
            vectorStore: fakeStore(files),
        });
        const out = await svc.build(symbols, repoId, { perSymbol: 8 });
        expect(out.stats.callers).toBeLessThanOrEqual(12);
    });

    it('returns empty when the budget is zero', async () => {
        const store = fakeStore(chunksByFile);
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: store,
        });
        const out = await svc.build(['save'], repoId, { perSymbol: 0 });
        expect(out.stats.callers).toBe(0);
        expect(store.getChunksForFiles).not.toHaveBeenCalled();
    });

    it('degrades to empty rather than throwing when the store fails', async () => {
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: { getChunksForFiles: async () => { throw new Error('IndexedDB gone'); } },
        });
        const out = await svc.build(['save'], repoId, { perSymbol: 3 });
        expect(out).toEqual({ bySymbol: {}, stats: { symbols: 0, callers: 0, filesLoaded: 0 } });
    });

    it('returns empty without a vector store, preserving the old behaviour', async () => {
        const svc = new CallerSourceService({ codeGraphPipeline: fakePipeline(callers) });
        expect((await svc.build(['save'], repoId)).stats.callers).toBe(0);
    });

    it('numbers the excerpt from the chunk\'s recorded start line', async () => {
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: fakeStore({
                'src/api/upload.js': [{ chunkIndex: 0, content: UPLOAD_SRC, startLine: 100 }],
            }),
        });
        const out = await svc.build(['save'], repoId, { perSymbol: 1 });
        expect(out.bySymbol.save).toContain('lines 100+, real line numbers shown');
        // The chunk begins at 100 with the import; the declaration is two below.
        expect(out.bySymbol.save).toMatch(/^100 \| import \{ save \}/m);
        expect(out.bySymbol.save).toMatch(/^102 \| export function handleUpload/m);
    });

    it('leaves the excerpt unnumbered when the index predates line tracking', async () => {
        // A confidently wrong line is worse than none — locations are
        // load-bearing for citation enforcement and the hunk filter.
        const svc = new CallerSourceService({
            codeGraphPipeline: fakePipeline(callers),
            vectorStore: fakeStore(chunksByFile),  // no startLine
        });
        const out = await svc.build(['save'], repoId, { perSymbol: 1 });
        expect(out.bySymbol.save).toContain('do not cite them');
        expect(out.bySymbol.save).not.toMatch(/^\s*\d+ \|/m);
    });
});

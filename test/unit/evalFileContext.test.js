/**
 * The harness wiring has one failure mode that matters: it looks like it is
 * supplying file context while supplying nothing usable. That happens when the
 * cached content has drifted from the cached patch — `verifyAlignment` then
 * correctly refuses to expand, and the run measures the patch-only pipeline while
 * every log line says otherwise.
 *
 * These tests pin the alignment reporting that makes that visible, and the
 * injector's content-rewriting that prevents it for injected corpora.
 */

const {
    buildFileContext,
    buildDeclarations,
    alignmentReport,
} = require('../../eval/lib/fileContext.js');
const { injectIntoFile, injectIntoPr } = require('../../eval/lib/defects.js');

const FILE_LINES = [
    'const db = require("./db");',                 // 1
    '',                                            // 2
    'function loadUser(id) {',                     // 3
    '    if (!id) throw new Error("no id");',      // 4
    '    const row = db.get(id);',                 // 5
    '    return row ?? null;',                     // 6
    '}',                                           // 7
];
const CONTENT = FILE_LINES.join('\n');

const PATCH = [
    '@@ -4,3 +4,3 @@',
    '     if (!id) throw new Error("no id");',
    '-    const row = db.find(id);',
    '+    const row = db.get(id);',
    '     return row ?? null;',
].join('\n');

function makeCase(over = {}) {
    return {
        id: 'acme/repo#1',
        url: 'https://github.com/acme/repo/pull/1',
        prData: {
            headSha: 'abc',
            files: [{ filename: 'src/users.js', status: 'modified', additions: 1, deletions: 1, patch: PATCH }],
        },
        fileContents: { 'src/users.js': CONTENT },
        ...over,
    };
}

describe('buildFileContext', () => {
    it('builds the same shape ReviewFileContextService returns', () => {
        const { fileContext, stats } = buildFileContext(makeCase());
        const entry = fileContext.get('src/users.js');

        expect(entry).toMatchObject({
            fullContent: CONTENT,
            truncated: false,
            testFileMissing: true,
        });
        expect(entry).toHaveProperty('testPath', null);
        expect(entry).toHaveProperty('testContent', null);
        expect(stats.withContent).toBe(1);
    });

    it('reports files with no cached content rather than inventing any', () => {
        const kase = makeCase({ fileContents: {} });
        const { fileContext, stats } = buildFileContext(kase);
        expect(fileContext.size).toBe(0);
        expect(stats.withoutContent).toBe(1);
    });

    it('marks content at the fetcher cap as truncated', () => {
        // dynamicContext refuses to expand truncated content; claiming otherwise
        // would let it expand into a file that stops mid-way.
        const kase = makeCase({ fileContents: { 'src/users.js': 'x'.repeat(60_000) } });
        expect(buildFileContext(kase).fileContext.get('src/users.js').truncated).toBe(true);
    });

    it('finds a test file that the PR also changed', () => {
        const kase = makeCase({
            prData: {
                headSha: 'abc',
                files: [
                    { filename: 'src/users.js', patch: PATCH },
                    { filename: 'src/users.test.js', patch: '@@ -1 +1 @@\n+test("x", () => {});' },
                ],
            },
            fileContents: {
                'src/users.js': CONTENT,
                'src/users.test.js': 'test("x", () => {});',
            },
        });
        const { fileContext, stats } = buildFileContext(kase);
        expect(fileContext.get('src/users.js').testPath).toBe('src/users.test.js');
        expect(stats.testsFound).toBe(1);
    });

    it('does not look for a test file for a test file', () => {
        const kase = makeCase({
            prData: { headSha: 'a', files: [{ filename: 'src/a.test.js', patch: PATCH }] },
            fileContents: { 'src/a.test.js': CONTENT },
        });
        const entry = buildFileContext(kase).fileContext.get('src/a.test.js');
        expect(entry.testFileMissing).toBe(false);
        expect(entry.testPath).toBeNull();
    });

    it('survives a case with no prData or no contents', () => {
        expect(buildFileContext({}).fileContext.size).toBe(0);
        expect(buildFileContext(null).fileContext.size).toBe(0);
    });
});

describe('buildDeclarations', () => {
    it('extracts declaration ranges with the same extractor the extension uses', () => {
        const { fileContext } = buildFileContext(makeCase());
        const { declarationsByFile, stats } = buildDeclarations(fileContext);

        const decls = declarationsByFile.get('src/users.js');
        expect(decls.map(d => d.name)).toContain('loadUser');
        expect(decls[0]).toMatchObject({ startLine: 3 });
        expect(stats.files).toBe(1);
        expect(stats.declarations).toBeGreaterThan(0);
    });

    it('skips a file whose language it cannot identify', () => {
        const kase = makeCase({
            prData: { headSha: 'a', files: [{ filename: 'data.bin', patch: PATCH }] },
            fileContents: { 'data.bin': CONTENT },
        });
        const { fileContext } = buildFileContext(kase);
        const { declarationsByFile, stats } = buildDeclarations(fileContext);
        expect(declarationsByFile.size).toBe(0);
        expect(stats.unknownLanguage).toBe(1);
    });

    it('returns empty for an empty context', () => {
        expect(buildDeclarations(new Map()).declarationsByFile.size).toBe(0);
    });
});

describe('alignmentReport', () => {
    it('confirms content that matches the patch', () => {
        const kase = makeCase();
        const { fileContext } = buildFileContext(kase);
        const res = alignmentReport(kase, fileContext);

        expect(res.aligned).toBe(1);
        expect(res.misaligned).toBe(0);
    });

    it('flags content that has drifted from the patch, with a reason', () => {
        // This is the silent-failure case: a plausible score that actually
        // measures the patch-only pipeline.
        const stale = CONTENT.replace('db.get(id)', 'db.find(id)');
        const kase = makeCase({ fileContents: { 'src/users.js': stale } });
        const { fileContext } = buildFileContext(kase);
        const res = alignmentReport(kase, fileContext);

        expect(res.aligned).toBe(0);
        expect(res.misaligned).toBe(1);
        expect(res.reasons[0]).toMatchObject({ file: 'src/users.js' });
        expect(res.reasons[0].reason).toBeTruthy();
    });

    it('counts a file with no content separately from a misaligned one', () => {
        // "Never fetched" and "fetched but stale" need different fixes.
        const kase = makeCase({ fileContents: {} });
        const { fileContext } = buildFileContext(kase);
        const res = alignmentReport(kase, fileContext);
        expect(res).toMatchObject({ aligned: 0, misaligned: 0, noContent: 1 });
    });

    it('counts a file with no parseable patch as noContent', () => {
        const kase = makeCase({
            prData: { headSha: 'a', files: [{ filename: 'src/users.js', patch: '' }] },
        });
        const { fileContext } = buildFileContext(kase);
        expect(alignmentReport(kase, fileContext).noContent).toBe(1);
    });
});

describe('injection keeps cached content in step with the patch', () => {
    // Without this, the injected corpus has a patch saying one thing and a cached
    // file saying another; expansion is refused for every file and the
    // file-context path goes untested while appearing to be exercised.
    const cleanPatch = [
        '@@ -1,3 +1,4 @@',
        ' const a = 1;',
        '+const ok = a === b;',
        ' const c = 3;',
    ].join('\n');
    const cleanContent = ['const a = 1;', 'const ok = a === b;', 'const c = 3;'].join('\n');

    it('returns the exact line edits it made', () => {
        const res = injectIntoFile({ filename: 'a.js', patch: cleanPatch }, {});
        expect(res.edits).toHaveLength(1);
        expect(res.edits[0]).toMatchObject({ line: 2 });
        // The full rewritten line, not the truncated `before`/`after` summary.
        expect(res.patch).toContain(`+${res.edits[0].content}`);
    });

    it('applies those edits to the cached content', () => {
        const out = injectIntoPr(
            { files: [{ filename: 'a.js', patch: cleanPatch }] },
            { fileContents: { 'a.js': cleanContent } },
        );

        expect(out.fileContents['a.js']).not.toBe(cleanContent);
        // Patch and content still agree, which is what alignment checks.
        const injectedLine = out.prData.files[0].patch
            .split('\n').find(l => l.startsWith('+') && !l.startsWith('+++')).slice(1);
        expect(out.fileContents['a.js'].split('\n')[1]).toBe(injectedLine);
    });

    it('leaves the injected patch and content ALIGNED end to end', () => {
        const out = injectIntoPr(
            { headSha: 'a', files: [{ filename: 'a.js', patch: cleanPatch }] },
            { fileContents: { 'a.js': cleanContent } },
        );
        const kase = {
            url: 'https://github.com/a/b/pull/1',
            prData: out.prData,
            fileContents: out.fileContents,
        };
        const { fileContext } = buildFileContext(kase);
        expect(alignmentReport(kase, fileContext).aligned).toBe(1);
    });

    it('is a no-op when the corpus carries no content', () => {
        const out = injectIntoPr({ files: [{ filename: 'a.js', patch: cleanPatch }] }, {});
        expect(out.fileContents).toBeUndefined();
    });

    it('does not change line numbering', () => {
        // Injection rewrites lines in place; anything else would shift every
        // recorded ground-truth line.
        const out = injectIntoPr(
            { files: [{ filename: 'a.js', patch: cleanPatch }] },
            { fileContents: { 'a.js': cleanContent } },
        );
        expect(out.fileContents['a.js'].split('\n')).toHaveLength(cleanContent.split('\n').length);
    });
});

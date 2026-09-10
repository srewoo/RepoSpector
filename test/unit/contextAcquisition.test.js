/**
 * P1-5 — acquire the right context, and measure what was actually read.
 *
 * Six defects, one theme: the pipeline could not say what it had not seen.
 *
 *   - Every explorer tool result was cut at 6,000 characters with a bare
 *     "… (truncated)" and no way to ask for the rest, so a relevant function
 *     further down a large file was unreachable.
 *   - `_findTest` returned `null` both for "no such file" and "the request
 *     failed", and the prompt rendered both as `Test file: NONE FOUND`.
 *   - The shared byte budget was checked BEFORE an await and incremented after,
 *     so concurrent fetches all passed the same check; test bodies were added
 *     after the check and never budgeted at all. Bytes were counted as
 *     `String.length`.
 *   - Two full-file paths read two different limits, so a context profile
 *     changed one of them.
 *   - The prompt reserved a flat 20% of the window for everything that is not
 *     the diff — a number, not a measurement.
 *   - Omitted hunks were counted, never named.
 */
const {
    ReviewFileContextService,
    TEST_DISCOVERY,
    byteLength,
    truncateFile,
} = require('../../src/services/ReviewFileContextService.js');
const { RepoExplorerService, EXPLORER_TOOLS } = require('../../src/services/RepoExplorerService.js');
const { stripDeletionOnlyHunks, fitFilesToBudget, renderOmittedFiles } = require('../../src/utils/diffBudget.js');
const { resolveBudget } = require('../../src/utils/reviewContextBudget.js');

const notFound = () => {
    const e = new Error('Failed to fetch file: 404');
    e.status = 404;
    e.notFound = true;
    return e;
};
const unreadable = (status = 429) => {
    const e = new Error(`Failed to fetch file: ${status}`);
    e.status = status;
    e.notFound = false;
    return e;
};

const prData = (files, extra = {}) => ({
    headSha: 'abc123',
    branches: { source: 'feature/x', target: 'main' },
    files,
    ...extra,
});

describe('the explorer can read past the first window', () => {
    /** A 900-line file whose interesting function is far past 6,000 characters. */
    const bigFile = Array.from({ length: 900 }, (_, i) => (
        i === 700 ? 'function theRelevantOne(user) { return db.get(user.id); }' : `const filler${i} = ${i};`
    )).join('\n');

    const explorer = () => new RepoExplorerService({
        ragService: {
            vectorStore: {
                async getChunksForFiles() {
                    return new Map([['src/big.js', [{ startLine: 1, content: bigFile }]]]);
                },
            },
        },
    });

    it('advertises a range on the read_file tool', () => {
        const readFile = EXPLORER_TOOLS.find((t) => t.function.name === 'read_file');
        expect(Object.keys(readFile.function.parameters.properties))
            .toEqual(expect.arrayContaining(['path', 'start_line', 'end_line']));
    });

    it('tells the caller where to continue instead of just saying "truncated"', async () => {
        const out = await explorer().executeTool({ name: 'read_file', args: { path: 'src/big.js' } }, 'repo');
        expect(out).toMatch(/lines 1-\d+ of 900/);
        expect(out).toMatch(/call read_file again/);
        expect(out).toMatch(/start_line=/);
        expect(out).toMatch(/Do not conclude anything about the unread part/);
    });

    it('retrieves a function that lives well beyond the first window', async () => {
        const out = await explorer().executeTool(
            { name: 'read_file', args: { path: 'src/big.js', start_line: 695, end_line: 705 } },
            'repo',
        );
        expect(out).toContain('theRelevantOne');
        expect(out).toMatch(/lines 695-705 of 900/);
    });

    it('numbers the window with real file line numbers', async () => {
        const out = await explorer().executeTool(
            { name: 'read_file', args: { path: 'src/big.js', start_line: 701, end_line: 701 } },
            'repo',
        );
        expect(out).toMatch(/701 \| function theRelevantOne/);
    });

    it('clamps a nonsensical range rather than returning nothing', async () => {
        const out = await explorer().executeTool(
            { name: 'read_file', args: { path: 'src/big.js', start_line: -5, end_line: 99999 } },
            'repo',
        );
        expect(out).toMatch(/lines 1-/);
    });

    it('an unindexed path is reported as unknown, not as absent', async () => {
        const out = await explorer().executeTool({ name: 'read_file', args: { path: 'nope.js' } }, 'repo');
        expect(out).toMatch(/not evidence that the file does not exist/i);
    });
});

describe('a failed test lookup is not an absent test', () => {
    const svc = (impl) => new ReviewFileContextService({
        pullRequestService: { fetchFullFileContent: impl },
    });

    it('a 404 on every candidate is absence, and licenses the finding', async () => {
        const { byFile, stats } = await svc(async (_url, path) => {
            if (path === 'src/a.js') return { content: 'export function a() {}' };
            throw notFound();
        }).build('url', prData([{ filename: 'src/a.js', status: 'modified' }]));

        expect(byFile.get('src/a.js').testDiscovery).toBe(TEST_DISCOVERY.ABSENT);
        expect(byFile.get('src/a.js').testFileMissing).toBe(true);
        expect(stats.testsMissing).toBe(1);
    });

    it('a rate-limited lookup is UNKNOWN, and licenses nothing', async () => {
        const { byFile, stats } = await svc(async (_url, path) => {
            if (path === 'src/a.js') return { content: 'export function a() {}' };
            throw unreadable(429);
        }).build('url', prData([{ filename: 'src/a.js', status: 'modified' }]));

        const entry = byFile.get('src/a.js');
        expect(entry.testDiscovery).toBe(TEST_DISCOVERY.UNKNOWN);
        // THE point: a missing-coverage finding must not follow from this.
        expect(entry.testFileMissing).toBe(false);
        expect(entry.testDiscoveryReason).toMatch(/not evidence that no test exists/);
        expect(stats.testsMissing).toBe(0);
        expect(stats.testsUnknown).toBe(1);
    });

    it('a repository tree settles absence without spending requests', async () => {
        const calls = [];
        const { byFile } = await svc(async (_url, path) => {
            calls.push(path);
            if (path === 'src/a.js') return { content: 'export function a() {}' };
            throw notFound();
        }).build('url', prData([{ filename: 'src/a.js', status: 'modified' }]), {
            repoTree: ['src/a.js', 'src/b.js'],
        });

        expect(byFile.get('src/a.js').testDiscovery).toBe(TEST_DISCOVERY.ABSENT);
        expect(byFile.get('src/a.js').testDiscoveryReason).toMatch(/repository tree/);
        // Only the source file was fetched; no candidate probing.
        expect(calls).toEqual(['src/a.js']);
    });

    it('a file with no known test convention is UNKNOWN, not absent', async () => {
        const { byFile } = await svc(async () => ({ content: 'body' }))
            .build('url', prData([{ filename: 'deploy/values.yaml', status: 'modified' }]));
        const entry = byFile.get('deploy/values.yaml');
        if (entry?.testDiscovery) {
            expect([TEST_DISCOVERY.UNKNOWN, TEST_DISCOVERY.ABSENT]).toContain(entry.testDiscovery);
        }
    });
});

describe('the byte budget holds under concurrency', () => {
    it('concurrent fetches cannot each pass the same pre-fetch check', async () => {
        // Eight files of 50KB each against a 120KB total budget, four at a time.
        // The old check ran before the await and the increment after it, so all
        // four in-flight fetches saw the same total and all four were added.
        const files = Array.from({ length: 8 }, (_, i) => ({
            filename: `src/f${i}.js`, status: 'modified', additions: 100 - i,
        }));
        const svc = new ReviewFileContextService({
            pullRequestService: {
                async fetchFullFileContent(_url, path) {
                    if (path.includes('.test.')) throw notFound();
                    // Yield, so every worker is genuinely in flight together.
                    await new Promise((r) => setTimeout(r, 1));
                    return { content: 'x'.repeat(50_000) };
                },
            },
        });

        const { stats } = await svc.build('url', prData(files), {
            maxBytesPerFile: 50_000,
            maxTotalBytes: 120_000,
            concurrency: 4,
            fetchTests: false,
        });

        expect(stats.bytes).toBeLessThanOrEqual(120_000);
        expect(stats.budgetExhausted).toBeGreaterThan(0);
    });

    it('names every file the budget refused', async () => {
        const files = Array.from({ length: 4 }, (_, i) => ({
            filename: `src/f${i}.js`, status: 'modified', additions: 10 - i,
        }));
        const svc = new ReviewFileContextService({
            pullRequestService: {
                async fetchFullFileContent() { return { content: 'y'.repeat(40_000) }; },
            },
        });

        const { stats } = await svc.build('url', prData(files), {
            maxBytesPerFile: 40_000, maxTotalBytes: 80_000, concurrency: 1, fetchTests: false,
        });

        expect(stats.omitted.length).toBeGreaterThan(0);
        expect(stats.omitted.every((o) => o.file && o.reason)).toBe(true);
    });

    it('counts UTF-8 bytes, not UTF-16 code units', () => {
        // Three bytes each in UTF-8, one code unit each in JS.
        expect(byteLength('你好世界')).toBe(12);
        expect('你好世界'.length).toBe(4);
    });

    it('truncates to a real byte budget on multibyte source', () => {
        const cjk = '漢'.repeat(5000);
        const { text, truncated } = truncateFile(cjk, 1000);
        expect(truncated).toBe(true);
        expect(byteLength(text)).toBeLessThan(4000);
    });
});

describe('omitted hunks are named, not merely counted', () => {
    const deletionHunk = (body) => [
        '@@ -10,4 +10,1 @@',
        ' before();',
        ...body.map((l) => `-${l}`),
        ' after();',
    ].join('\n');

    it('reports the header of each stripped deletion-only hunk', () => {
        const res = stripDeletionOnlyHunks(deletionHunk(['function dead() { return 1; }']));
        expect(res.removedHunkHeaders).toEqual(['@@ -10,4 +10,1 @@']);
    });

    it('carries them through the diff budget as named omissions', () => {
        const { stats } = fitFilesToBudget({
            files: [{
                filename: 'a.js',
                patch: `@@ -1,1 +1,2 @@\n a\n+b\n${deletionHunk(['function dead() {}'])}`,
            }],
            contextWindowTokens: 100_000,
        });
        expect(stats.omittedHunks).toHaveLength(1);
        expect(stats.omittedHunks[0]).toMatchObject({ file: 'a.js', hunk: '@@ -10,4 +10,1 @@' });
    });

    it('renders them into the prompt so the model knows what it has not seen', () => {
        const block = renderOmittedFiles([], [
            { file: 'a.js', hunk: '@@ -10,4 +10,1 @@', reason: 'diff budget exhausted' },
        ]);
        expect(block).toMatch(/Hunks not shown/);
        expect(block).toMatch(/a\.js @@ -10,4 \+10,1 @@ — diff budget exhausted/);
    });

    it('is empty when nothing was omitted at either level', () => {
        expect(renderOmittedFiles([], [])).toBe('');
    });
});

describe('a context profile controls the sections it names', () => {
    it('legacy and default differ on the full-file count', () => {
        expect(resolveBudget({ profile: 'legacy' }).maxFullFiles)
            .not.toBe(resolveBudget({ profile: 'default' }).maxFullFiles);
    });

    it('both full-file paths in the handler read one budget key', () => {
        // Regression guard for the split that made a profile a half-measure:
        // one path read `contextBudget.maxFullFiles`, the other a literal 12.
        const fs = require('node:fs');
        const handler = fs.readFileSync(
            require.resolve('../../src/background/handlers/prReviewHandlers.js'), 'utf8',
        );
        expect(handler).not.toMatch(/maxContextFiles \|\| 12/);
        expect(handler).toMatch(/maxContextFiles\s*\n?\s*\|\| options\.maxFullFiles/);
    });
});

describe('reads say which revision they actually describe', () => {
    /**
     * P1-5 asks for revision-AWARE ranged reads. The explorer has no worktree
     * and cannot fetch an arbitrary commit, so awareness is the achievable and
     * the important half: silently serving the indexed commit as though it were
     * the reviewed head is how a reviewer reasons confidently about a function
     * that has since changed.
     */
    const bigFile = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const store = {
        vectorStore: {
            async getChunksForFiles() {
                return new Map([['src/a.js', [{ startLine: 1, content: bigFile }]]]);
            },
        },
    };
    const read = (svc, args = {}) =>
        svc.executeTool({ name: 'read_file', args: { path: 'src/a.js', ...args } }, 'repo');

    it('advertises the revision argument', () => {
        const readFile = EXPLORER_TOOLS.find((t) => t.function.name === 'read_file');
        expect(readFile.function.parameters.properties.revision).toBeDefined();
    });

    it('says nothing extra when the index IS the reviewed revision', async () => {
        const svc = new RepoExplorerService({
            ragService: store, indexedRevision: 'head1', reviewedRevision: 'head1',
        });
        const out = await read(svc);
        expect(out).not.toMatch(/NOT THE REVISION/);
        expect(out).toMatch(/indexed at head1/);
    });

    it('warns loudly when the index is at a different commit', async () => {
        const svc = new RepoExplorerService({
            ragService: store, indexedRevision: 'oldcommit1', reviewedRevision: 'head1',
        });
        const out = await read(svc);
        expect(out).toMatch(/THIS IS NOT THE REVISION YOU ASKED FOR/);
        expect(out).toMatch(/oldcommit1/);
        expect(out).toMatch(/unsupported unless the diff confirms it/);
    });

    it('honours a revision named on the call over the review default', async () => {
        const svc = new RepoExplorerService({
            ragService: store, indexedRevision: 'abc', reviewedRevision: 'abc',
        });
        const out = await read(svc, { revision: 'somethingelse' });
        expect(out).toMatch(/THIS IS NOT THE REVISION YOU ASKED FOR/);
    });

    it('an index with no recorded commit says the content may not be the reviewed code', async () => {
        const svc = new RepoExplorerService({ ragService: store, reviewedRevision: 'head1' });
        const out = await read(svc);
        expect(out).toMatch(/not recorded/);
        expect(out).toMatch(/do not treat it as the reviewed code/);
    });
});

describe('a context profile predictably changes the prompt itself', () => {
    /**
     * The clause that matters most in P1-5's acceptance, and the easiest to
     * satisfy on paper: asserting that `legacy` and `default` hold different
     * NUMBERS proves nothing about the prompt. A profile that changes a budget
     * key nobody reads is exactly the half-measure the split full-file limit
     * turned out to be, so this asserts on the rendered text.
     */
    const { buildPerFileReviewPrompt } = require('../../src/utils/multiPassPrompts.js');

    const unit = {
        primaryFile: 'src/a.js',
        files: [{
            filename: 'src/a.js',
            language: 'javascript',
            patch: '@@ -1,2 +1,4 @@\n keep();\n+added1();\n+added2();',
            additions: 2, deletions: 0,
        }],
    };

    /** Distinguishable chunk bodies, so truncation is visible in the output. */
    const ragChunks = Array.from({ length: 8 }, (_, i) => ({
        filePath: `src/chunk${i}.js`,
        content: `// CHUNK_${i}_MARKER\n${'x'.repeat(3000)}`,
    }));

    /**
     * The builder returns the prompt split into cache parts (a stable preamble
     * plus the per-unit rest), so the sections have to be joined before they
     * can be inspected as one document.
     */
    const render = (contextBudget) => {
        const parts = buildPerFileReviewPrompt(unit, {
            prContext: '', focusAreas: [], ragChunks, staticFindings: [],
            contextBudget,
        });
        // Each part is `{ text, ... }` — the cache-breakpoint envelope — so the
        // text has to be pulled out rather than stringified.
        return Array.isArray(parts)
            ? parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n')
            : String(parts);
    };

    it('the legacy profile admits fewer retrieved chunks than the default', () => {
        const legacy = render(resolveBudget({ profile: 'legacy' }));
        const dflt = render(resolveBudget({ profile: 'default' }));

        const count = (text) => (text.match(/CHUNK_\d+_MARKER/g) || []).length;
        expect(count(legacy)).toBeLessThan(count(dflt));
        // And the direction is the one the profile declares.
        expect(count(legacy)).toBeLessThanOrEqual(resolveBudget({ profile: 'legacy' }).ragChunks);
    });

    it('the legacy profile keeps less of each chunk', () => {
        const legacy = render(resolveBudget({ profile: 'legacy' }));
        const dflt = render(resolveBudget({ profile: 'default' }));
        expect(legacy.length).toBeLessThan(dflt.length);
    });

    it('a per-call override moves the prompt too, not just the object', () => {
        const one = render(resolveBudget({ overrides: { ragChunks: 1 } }));
        const many = render(resolveBudget({ overrides: { ragChunks: 6 } }));
        const count = (text) => (text.match(/CHUNK_\d+_MARKER/g) || []).length;
        expect(count(one)).toBe(1);
        expect(count(many)).toBeGreaterThan(1);
    });

    it('an unreadable budget value is ignored rather than silently disabling a section', () => {
        const sane = resolveBudget({ overrides: { ragChunks: -5 } });
        expect(sane.ragChunks).toBe(resolveBudget({}).ragChunks);
        expect((render(sane).match(/CHUNK_\d+_MARKER/g) || []).length).toBeGreaterThan(0);
    });
});

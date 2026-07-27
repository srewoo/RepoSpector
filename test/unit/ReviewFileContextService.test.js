const {
    ReviewFileContextService,
    truncateFile,
} = require('../../src/services/ReviewFileContextService.js');
const { testCandidatesForProduction } = require('../../src/services/testFileUtils.js');

/** A fake PullRequestService backed by an in-memory filesystem. */
function fakePrService(files, { failOn = [] } = {}) {
    const calls = [];
    return {
        calls,
        async fetchFullFileContent(prUrl, path, ref) {
            calls.push({ path, ref });
            if (failOn.includes(path)) throw new Error('boom');
            if (!(path in files)) throw new Error('404');
            return { content: files[path], filePath: path };
        },
    };
}

const prData = (files, extra = {}) => ({
    headSha: 'abc123',
    branches: { source: 'feature/x', target: 'main' },
    files,
    ...extra,
});

describe('truncateFile', () => {
    it('leaves a small file alone', () => {
        const { text, truncated } = truncateFile('hello', 100);
        expect(text).toBe('hello');
        expect(truncated).toBe(false);
    });

    it('keeps the head AND the tail, so exports at the bottom survive', () => {
        const body = 'HEAD_MARKER\n' + 'x'.repeat(5000) + '\nTAIL_MARKER';
        const { text, truncated } = truncateFile(body, 500);

        expect(truncated).toBe(true);
        expect(text).toContain('HEAD_MARKER');
        expect(text).toContain('TAIL_MARKER');
        expect(text).toContain('lines omitted');
    });
});

describe('testCandidatesForProduction', () => {
    it('offers same-directory .test first for JS', () => {
        const c = testCandidatesForProduction('src/utils/foo.js');
        expect(c[0]).toBe('src/utils/foo.test.js');
        expect(c).toContain('src/utils/__tests__/foo.test.js');
    });

    it('uses the enforced convention for Go and nothing else', () => {
        expect(testCandidatesForProduction('internal/svc/handler.go'))
            .toEqual(['internal/svc/handler_test.go']);
    });

    it('offers both Python conventions', () => {
        const c = testCandidatesForProduction('src/es_docs.py');
        expect(c).toContain('src/test_es_docs.py');
        expect(c).toContain('tests/test_es_docs.py');
    });

    it('returns nothing for a file that is already a test', () => {
        expect(testCandidatesForProduction('src/foo.test.js')).toEqual([]);
        expect(testCandidatesForProduction('internal/handler_test.go')).toEqual([]);
    });

    it('returns nothing for an extension it has no convention for', () => {
        expect(testCandidatesForProduction('README.md')).toEqual([]);
        expect(testCandidatesForProduction('Makefile')).toEqual([]);
    });

    it('does not emit a leading slash for a root-level file', () => {
        for (const c of testCandidatesForProduction('index.js')) {
            expect(c.startsWith('/')).toBe(false);
        }
    });
});

describe('ReviewFileContextService', () => {
    it('fetches full content at the PR head, not the default branch', async () => {
        const pr = fakePrService({ 'src/a.js': 'export function a() {}' });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        await svc.build('url', prData([{ filename: 'src/a.js', status: 'modified' }]));

        expect(pr.calls[0].ref).toBe('abc123');
    });

    it('attaches the test file when one exists', async () => {
        const pr = fakePrService({
            'src/a.js': 'export function a() {}',
            'src/a.test.js': "test('a', () => {})",
        });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile, stats } = await svc.build('url', prData([{ filename: 'src/a.js', status: 'modified' }]));

        const entry = byFile.get('src/a.js');
        expect(entry.fullContent).toContain('export function a');
        expect(entry.testPath).toBe('src/a.test.js');
        expect(entry.testContent).toContain("test('a'");
        expect(entry.testFileMissing).toBe(false);
        expect(stats.testsFound).toBe(1);
    });

    it('flags a missing test file, which is itself the finding', async () => {
        const pr = fakePrService({ 'src/a.js': 'export function a() {}' });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile, stats } = await svc.build('url', prData([{ filename: 'src/a.js', status: 'modified' }]));

        expect(byFile.get('src/a.js').testFileMissing).toBe(true);
        expect(stats.testsMissing).toBe(1);
    });

    it('reuses a test added in this same PR without extra guessing', async () => {
        const pr = fakePrService({
            'src/a.js': 'code',
            'src/__tests__/a.test.js': 'the test',
        });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile } = await svc.build('url', prData([
            { filename: 'src/a.js', status: 'modified' },
            { filename: 'src/__tests__/a.test.js', status: 'added' },
        ]));

        expect(byFile.get('src/a.js').testPath).toBe('src/__tests__/a.test.js');
    });

    it('degrades softly when a file cannot be fetched', async () => {
        const pr = fakePrService({ 'src/b.js': 'ok' }, { failOn: ['src/a.js'] });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile, stats } = await svc.build('url', prData([
            { filename: 'src/a.js', status: 'modified' },
            { filename: 'src/b.js', status: 'modified' },
        ]));

        expect(stats.failed).toBe(1);
        expect(byFile.get('src/a.js').fullContent).toBeNull();
        expect(byFile.get('src/b.js').fullContent).toBe('ok');
    });

    it('skips lockfiles, binaries and vendored paths without spending a call', async () => {
        const pr = fakePrService({});
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { stats } = await svc.build('url', prData([
            { filename: 'package-lock.json', status: 'modified' },
            { filename: 'yarn.lock', status: 'modified' },
            { filename: 'assets/logo.png', status: 'added' },
            { filename: 'node_modules/x/index.js', status: 'modified' },
        ]));

        expect(stats.requested).toBe(0);
        expect(pr.calls).toHaveLength(0);
    });

    it('does not try to read a deleted file at head', async () => {
        const pr = fakePrService({});
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        await svc.build('url', prData([{ filename: 'src/gone.js', status: 'removed' }]));
        expect(pr.calls).toHaveLength(0);
    });

    it('honours maxFiles, prioritising the largest diffs', async () => {
        const pr = fakePrService({ 'big.js': 'b', 'small.js': 's' });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile } = await svc.build('url', prData([
            { filename: 'small.js', status: 'modified', additions: 1, deletions: 0 },
            { filename: 'big.js', status: 'modified', additions: 200, deletions: 50 },
        ]), { maxFiles: 1, fetchTests: false });

        expect(byFile.has('big.js')).toBe(true);
        expect(byFile.has('small.js')).toBe(false);
    });

    it('restricts to onlyFiles on an incremental run', async () => {
        const pr = fakePrService({ 'a.js': 'a', 'b.js': 'b' });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile } = await svc.build('url', prData([
            { filename: 'a.js', status: 'modified' },
            { filename: 'b.js', status: 'modified' },
        ]), { onlyFiles: ['b.js'], fetchTests: false });

        expect(byFile.has('b.js')).toBe(true);
        expect(byFile.has('a.js')).toBe(false);
    });

    it('does not look for a test file for a test file', async () => {
        const pr = fakePrService({ 'src/a.test.js': 'the test' });
        const svc = new ReviewFileContextService({ pullRequestService: pr });

        const { byFile } = await svc.build('url', prData([{ filename: 'src/a.test.js', status: 'modified' }]));

        const entry = byFile.get('src/a.test.js');
        expect(entry.testFileMissing).toBe(false);
        expect(entry.testPath).toBeNull();
        expect(pr.calls).toHaveLength(1);
    });

    it('returns an empty context rather than throwing when the service is unavailable', async () => {
        const svc = new ReviewFileContextService({});
        const { byFile, stats } = await svc.build('url', prData([{ filename: 'a.js', status: 'modified' }]));
        expect(byFile.size).toBe(0);
        expect(stats.fetched).toBe(0);
    });
});

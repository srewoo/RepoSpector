/**
 * Regression tests for four gaps found auditing the indexing flow.
 *
 * The first is the one that mattered: every GitHub repo whose default branch is
 * not `main` failed to index at all, and told the user their URL was wrong.
 */

const { GitHubService } = require('../../src/services/GitHubService.js');
const {
    isIndexableCodeFile,
    isScriptDirFile,
} = require('../../src/utils/codeFileFilter.js');
const {
    assessGraphCoverage,
    graphCoverageWarning,
} = require('../../src/utils/graphCoverage.js');

/** Fetch double routing by URL substring, recording every request. */
function routedFetch(routes) {
    const calls = [];
    global.fetch = jest.fn(async (url) => {
        calls.push(String(url));
        for (const [needle, res] of Object.entries(routes)) {
            if (String(url).includes(needle)) {
                return {
                    ok: res.ok !== false,
                    status: res.status || (res.ok === false ? 404 : 200),
                    statusText: 'x',
                    json: async () => res.body ?? {},
                };
            }
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    });
    return calls;
}

describe('GitHub default branch resolution', () => {
    afterEach(() => { delete global.fetch; });

    it('parses a plain repo URL as "no branch specified", not "main"', () => {
        const svc = new GitHubService();
        expect(svc.parseGitHubUrl('https://github.com/git/git').branch).toBeNull();
    });

    it('keeps an explicit branch from the URL', () => {
        const svc = new GitHubService();
        expect(svc.parseGitHubUrl('https://github.com/a/b/tree/develop').branch).toBe('develop');
    });

    it('fetches the tree from the repo\'s real default branch', async () => {
        // The bug: `main` was requested unconditionally, which 404s on every
        // repo that never renamed its default branch.
        const calls = routedFetch({
            '/repos/git/git/git/trees/master': { body: { tree: [{ type: 'blob', path: 'a.c' }] } },
            '/repos/git/git': { body: { default_branch: 'master' } },
        });
        const svc = new GitHubService();
        const out = await svc.fetchRepoTree('git', 'git', null);

        expect(out.branch).toBe('master');
        expect(out.tree).toHaveLength(1);
        expect(calls.some(u => u.includes('/trees/main'))).toBe(false);
    });

    it('does not look up the default when the URL named a branch', async () => {
        const calls = routedFetch({
            '/trees/develop': { body: { tree: [] } },
        });
        const svc = new GitHubService();
        const out = await svc.fetchRepoTree('a', 'b', 'develop');

        expect(out.branch).toBe('develop');
        expect(calls.filter(u => u.endsWith('/repos/a/b'))).toHaveLength(0);
    });

    it('falls back to main only when the metadata call fails', async () => {
        // Previously this was the ONLY path that read default_branch — from an
        // error body that never contains it.
        const calls = routedFetch({
            '/trees/main': { body: { tree: [] } },
            '/repos/a/b': { ok: false },
        });
        const svc = new GitHubService();
        const out = await svc.fetchRepoTree('a', 'b', null);

        expect(out.branch).toBe('main');
        expect(calls.some(u => u.includes('/trees/main'))).toBe(true);
    });

    it('downloads files from the same ref the tree came from', async () => {
        // A tree read from `master` and blobs read from `main` is 404 for every
        // file — the resolved branch has to reach the download loop.
        const calls = routedFetch({
            '/repos/o/r/git/trees/master': { body: { tree: [{ type: 'blob', path: 'a.js', size: 10 }] } },
            '/repos/o/r/contents/a.js': { body: { content: btoa('hello'), encoding: 'base64' } },
            '/repos/o/r': { body: { default_branch: 'master' } },
        });
        const svc = new GitHubService();
        await svc.fetchRepositoryFiles('https://github.com/o/r');

        const contentCalls = calls.filter(u => u.includes('/contents/'));
        expect(contentCalls.length).toBeGreaterThan(0);
        for (const url of contentCalls) {
            expect(url).toContain('ref=master');
        }
    });

    it('reports tree truncation rather than silently indexing a subset', async () => {
        routedFetch({
            '/trees/main': { body: { tree: [], truncated: true } },
            '/repos/a/b': { body: { default_branch: 'main' } },
        });
        const svc = new GitHubService();
        const events = [];
        await svc.fetchRepositoryFiles('https://github.com/a/b', e => events.push(e));
        expect(events.some(e => e.status === 'warning' && /truncated/i.test(e.message))).toBe(true);
    });
});

describe('environment files are never indexed', () => {
    it.each([
        '.env',
        'config/prod.env',
        '.env.local',
        '.env.production',
        'apps/api/.env',
    ])('denies %s', (path) => {
        // `.pem` was already denied as "must never enter an index" while these —
        // where credentials actually live — were on the allow list, embedded,
        // and eligible to be retrieved into a prompt sent to the LLM provider.
        expect(isIndexableCodeFile(path)).toBe(false);
    });

    it.each([
        '.env.example',
        '.env.sample',
        '.env.template',
        'env.example',
        'app/.env.dist',
    ])('still indexes the template %s', (path) => {
        // Templates carry the variable names without the values — useful review
        // context and safe.
        expect(isIndexableCodeFile(path)).toBe(true);
    });

    it('denies a bare .env by policy, not by accident of dotfile parsing', () => {
        // It was previously skipped only because a leading-dot name parses as
        // having no extension — a coincidence a later change could undo.
        expect(isIndexableCodeFile('.env')).toBe(false);
        expect(isIndexableCodeFile('deeply/nested/.env')).toBe(false);
    });
});

describe('extensionless scripts under bin/', () => {
    it.each(['bin/deploy', 'bin/rails', 'scripts/setup', 'tools/lint', 'hack/build'])(
        'indexes %s', (path) => {
            // EXCLUDE_DIRS deliberately keeps `bin`, but the extension gate
            // dropped these anyway — the directory decision was necessary and
            // not sufficient.
            expect(isIndexableCodeFile(path)).toBe(true);
        },
    );

    it('does not allow extensionless files everywhere', () => {
        // "No extension" is also what a committed binary looks like.
        expect(isIndexableCodeFile('src/somebinary')).toBe(false);
        expect(isIndexableCodeFile('deploy')).toBe(false);
    });

    it('still denies a script directory nested inside an excluded one', () => {
        expect(isIndexableCodeFile('node_modules/pkg/bin/cli')).toBe(false);
    });

    it('isScriptDirFile needs a directory, not just a name', () => {
        expect(isScriptDirFile('bin/deploy')).toBe(true);
        expect(isScriptDirFile('bin')).toBe(false);
    });
});

describe('graph coverage', () => {
    const files = (...paths) => paths.map(path => ({ path }));

    it('counts files the tree-sitter grammars can parse', () => {
        const out = assessGraphCoverage(files('a.js', 'b.py', 'c.go', 'd.kt'));
        expect(out.parsed).toBe(3);
        expect(out.unparsed).toBe(1);
        expect(out.topUnparsed[0]).toEqual({ language: 'Kotlin', count: 1 });
    });

    it('ignores files that have no call graph to begin with', () => {
        // Warning about README.md would be noise — nothing was lost.
        const out = assessGraphCoverage(files('README.md', 'config.yaml', 'style.css'));
        expect(out.total).toBe(0);
        expect(graphCoverageWarning(out)).toBeNull();
    });

    it('stays quiet when most of the repo is parseable', () => {
        const out = assessGraphCoverage(files('a.ts', 'b.ts', 'c.ts', 'run.sh'));
        expect(graphCoverageWarning(out)).toBeNull();
    });

    it('warns, naming the languages, when most of it is not', () => {
        const out = assessGraphCoverage(files('a.kt', 'b.kt', 'c.kt', 'd.swift', 'e.js'));
        const warning = graphCoverageWarning(out);
        expect(warning).toContain('Kotlin');
        expect(warning).toContain('20%');
        // The point of the message: which findings will be missing, and which won't.
        expect(warning).toContain('cross-file impact');
        expect(warning).toContain('Search and retrieval are unaffected');
    });

    it('says nothing for an empty repo', () => {
        expect(graphCoverageWarning(assessGraphCoverage([]))).toBeNull();
        expect(graphCoverageWarning(null)).toBeNull();
    });
});

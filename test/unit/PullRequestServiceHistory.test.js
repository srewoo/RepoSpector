/**
 * Blame, file history and prior review comments for the history and
 * priorPrComments lenses. Each call must hit the right endpoint on the right
 * host (github.com, GHE, gitlab.com, self-hosted GitLab), map the response to
 * the context-port shape, and THROW with a reason on failure — the adapter
 * reports it as not-run; nothing here may turn a 403 into "no history".
 */

const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { githubGraphqlUrl } = require('../../src/services/prHistory.js');
const { setGitHubHosts, resetGitHubHosts } = require('../../src/utils/gitHosts.js');

const ok = (body) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });
const fail = (status) => ({ ok: false, status, statusText: 'Forbidden', json: async () => ({}) });

const GH_PR = 'https://github.com/o/r/pull/42';
const GL_MR = 'https://git.acme.io/grp/sub/proj/-/merge_requests/9';
const BASE = 'b'.repeat(40);

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { delete global.fetch; resetGitHubHosts(); });

describe('githubGraphqlUrl', () => {
    it('maps REST bases to GraphQL endpoints', () => {
        expect(githubGraphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql');
        expect(githubGraphqlUrl('https://ghe.acme.com/api/v3')).toBe('https://ghe.acme.com/api/graphql');
    });
});

describe('fetchBlame', () => {
    const graphqlRanges = {
        data: { repository: { object: { blame: { ranges: [
            { startingLine: 1, endingLine: 4, commit: { oid: 'c1', message: 'init\n', committedDate: '2024-01-01' } },
            { startingLine: 5, endingLine: 9, commit: { oid: 'c2', message: 'fix: guard null', committedDate: '2025-02-02' } },
            { startingLine: 10, endingLine: 30, commit: { oid: 'c3', message: 'refactor', committedDate: '2025-03-03' } },
        ] } } } },
    };

    it('GitHub: POSTs GraphQL with a bearer token and keeps ranges overlapping the window', async () => {
        global.fetch.mockResolvedValueOnce(ok(graphqlRanges));
        const svc = new PullRequestService({ githubToken: 'tok' });

        const out = await svc.fetchBlame(GH_PR, 'src/a.js', BASE, 6, 8);

        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.github.com/graphql');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('bearer tok');
        expect(JSON.parse(init.body).variables).toEqual({ owner: 'o', name: 'r', expr: BASE, path: 'src/a.js' });
        expect(out).toEqual([{ start: 5, end: 9, sha: 'c2', message: 'fix: guard null', date: '2025-02-02' }]);
    });

    it('GitHub Enterprise: uses <host>/api/graphql', async () => {
        setGitHubHosts(['ghe.acme.com']);
        global.fetch.mockResolvedValueOnce(ok(graphqlRanges));
        await new PullRequestService({ githubToken: 'tok' }).fetchBlame('https://ghe.acme.com/o/r/pull/1', 'a.js', BASE);
        expect(global.fetch.mock.calls[0][0]).toBe('https://ghe.acme.com/api/graphql');
    });

    it('GitHub: refuses without a token, before any request', async () => {
        await expect(new PullRequestService().fetchBlame(GH_PR, 'a.js', BASE, 1, 2)).rejects.toThrow(/needs a GitHub token/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('GitHub: surfaces GraphQL errors and HTTP errors', async () => {
        global.fetch.mockResolvedValueOnce(ok({ errors: [{ message: 'Could not resolve to a Repository' }] }));
        await expect(new PullRequestService({ githubToken: 't' }).fetchBlame(GH_PR, 'a.js', BASE))
            .rejects.toThrow('GitHub blame: Could not resolve to a Repository');

        global.fetch.mockResolvedValueOnce(fail(403));
        await expect(new PullRequestService({ githubToken: 't' }).fetchBlame(GH_PR, 'a.js', BASE))
            .rejects.toThrow('GitHub blame: HTTP 403 Forbidden');
    });

    it('GitLab self-hosted: windowed REST blame, line numbers derived from group sizes', async () => {
        global.fetch.mockResolvedValueOnce(ok([
            { commit: { id: 'g1', message: 'add retry', committed_date: '2025-01-01' }, lines: ['a', 'b'] },
            { commit: { id: 'g2', message: 'tune', committed_date: '2025-02-01' }, lines: ['c'] },
        ]));
        const svc = new PullRequestService({ gitlabToken: 'gl' });

        const out = await svc.fetchBlame(GL_MR, 'lib/x.rb', BASE, 10, 12);

        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe(`https://git.acme.io/api/v4/projects/grp%2Fsub%2Fproj/repository/files/lib%2Fx.rb/blame?ref=${BASE}&range%5Bstart%5D=10&range%5Bend%5D=12`);
        expect(init.headers).toEqual({ 'PRIVATE-TOKEN': 'gl' });
        expect(out).toEqual([
            { start: 10, end: 11, sha: 'g1', message: 'add retry', date: '2025-01-01' },
            { start: 12, end: 12, sha: 'g2', message: 'tune', date: '2025-02-01' },
        ]);
    });

    it('requires a ref and a supported URL', async () => {
        const svc = new PullRequestService({ githubToken: 't' });
        await expect(svc.fetchBlame(GH_PR, 'a.js', null)).rejects.toThrow(/no ref/);
        await expect(svc.fetchBlame('https://example.com/x', 'a.js', BASE)).rejects.toThrow(/Unsupported PR\/MR URL/);
    });
});

describe('fetchRecentCommits', () => {
    it('GitHub: /commits?path&sha&per_page', async () => {
        global.fetch.mockResolvedValueOnce(ok([{ sha: 's1', commit: { message: 'fix: x\n\nbody', author: { date: 'd1' } } }]));
        const out = await new PullRequestService({ githubToken: 't' }).fetchRecentCommits(GH_PR, 'src/a.js', BASE, 5);
        expect(global.fetch.mock.calls[0][0]).toBe(`https://api.github.com/repos/o/r/commits?path=src%2Fa.js&per_page=5&sha=${BASE}`);
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('token t');
        expect(out).toEqual([{ sha: 's1', message: 'fix: x\n\nbody', date: 'd1' }]);
    });

    it('GitLab: /repository/commits?path&ref_name&per_page', async () => {
        global.fetch.mockResolvedValueOnce(ok([{ id: 'g1', message: 'm ', committed_date: 'd' }]));
        const out = await new PullRequestService().fetchRecentCommits(GL_MR, 'a.py', BASE, 3);
        expect(global.fetch.mock.calls[0][0]).toBe(`https://git.acme.io/api/v4/projects/grp%2Fsub%2Fproj/repository/commits?path=a.py&per_page=3&ref_name=${BASE}`);
        expect(out).toEqual([{ sha: 'g1', message: 'm', date: 'd' }]);
    });

    it('throws on HTTP failure', async () => {
        global.fetch.mockResolvedValueOnce(fail(429));
        await expect(new PullRequestService().fetchRecentCommits(GH_PR, 'a.js', BASE)).rejects.toThrow('GitHub commits: HTTP 429');
    });
});

describe('fetchPriorPrComments', () => {
    it('GitHub: commits -> merged PRs (current excluded) -> comments on this path only', async () => {
        global.fetch.mockImplementation(async (url) => {
            if (url.includes('/commits?')) return ok([{ sha: 'c1' }, { sha: 'c2' }]);
            if (url.endsWith('/commits/c1/pulls')) return ok([{ number: 42, merged_at: 'x' }, { number: 7, merged_at: 'x' }]);
            if (url.endsWith('/commits/c2/pulls')) return ok([{ number: 8, merged_at: null }, { number: 7, merged_at: 'x' }]);
            if (url.includes('/pulls/7/comments')) {
                return ok([
                    { path: 'src/a.js', body: 'cache this', user: { login: 'ann' }, line: 12 },
                    { path: 'src/other.js', body: 'nope', user: { login: 'bob' }, line: 1 },
                ]);
            }
            throw new Error(`unexpected ${url}`);
        });

        const out = await new PullRequestService({ githubToken: 't' })
            .fetchPriorPrComments(GH_PR, 'src/a.js', { limitPrs: 5, excludeNumber: 42 });

        expect(global.fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/commits?path=src%2Fa.js&per_page=10');
        expect(out).toEqual([{ path: 'src/a.js', prRef: '#7', author: 'ann', body: 'cache this', line: 12 }]);
        expect(global.fetch.mock.calls.some(([u]) => u.includes('/pulls/42/'))).toBe(false);
        expect(global.fetch.mock.calls.some(([u]) => u.includes('/pulls/8/'))).toBe(false);
    });

    it('GitHub: stops at limitPrs and scans at most 2 x limitPrs commits', async () => {
        global.fetch.mockImplementation(async (url) => {
            if (url.includes('/commits?')) return ok([{ sha: 'c1' }, { sha: 'c2' }]);
            if (url.includes('/pulls')) {
                if (url.endsWith('/pulls')) return ok([{ number: 1, merged_at: 'x' }, { number: 2, merged_at: 'x' }]);
                return ok([]);
            }
            throw new Error(url);
        });
        await new PullRequestService().fetchPriorPrComments(GH_PR, 'a.js', { limitPrs: 1 });
        expect(global.fetch.mock.calls[0][0]).toContain('per_page=2');
        const commentCalls = global.fetch.mock.calls.filter(([u]) => u.includes('/comments'));
        expect(commentCalls.map(([u]) => u)).toEqual(['https://api.github.com/repos/o/r/pulls/1/comments?per_page=100']);
    });

    it('GitLab: commits -> merged MRs -> DiffNotes on this path', async () => {
        global.fetch.mockImplementation(async (url) => {
            const base = 'https://git.acme.io/api/v4/projects/grp%2Fsub%2Fproj';
            if (url === `${base}/repository/commits?path=lib%2Fx.rb&per_page=10`) return ok([{ id: 'g1' }]);
            if (url === `${base}/repository/commits/g1/merge_requests`) {
                return ok([{ iid: 9, state: 'merged' }, { iid: 3, state: 'merged' }, { iid: 4, state: 'opened' }]);
            }
            if (url === `${base}/merge_requests/3/discussions?per_page=100`) {
                return ok([{ notes: [
                    { type: 'DiffNote', system: false, body: 'n+1 here', author: { username: 'cy' }, position: { new_path: 'lib/x.rb', new_line: 20 } },
                    { type: 'DiffNote', system: false, body: 'other file', author: { username: 'cy' }, position: { new_path: 'lib/y.rb', new_line: 1 } },
                    { type: null, system: false, body: 'general', author: { username: 'cy' } },
                    { type: 'DiffNote', system: true, body: 'changed line', position: { new_path: 'lib/x.rb' } },
                ] }]);
            }
            throw new Error(`unexpected ${url}`);
        });

        const out = await new PullRequestService({ gitlabToken: 'gl' })
            .fetchPriorPrComments(GL_MR, 'lib/x.rb', { limitPrs: 5, excludeNumber: 9 });

        expect(out).toEqual([{ path: 'lib/x.rb', prRef: '!3', author: 'cy', body: 'n+1 here', line: 20 }]);
    });

    it('throws when any step fails, rather than returning a partial "no comments"', async () => {
        global.fetch.mockImplementation(async (url) => (url.includes('/commits?') ? ok([{ sha: 'c1' }]) : fail(403)));
        await expect(new PullRequestService().fetchPriorPrComments(GH_PR, 'a.js'))
            .rejects.toThrow('GitHub commit pulls: HTTP 403 Forbidden');
    });
});

describe('non-finite limits fall back to defaults (never per_page=NaN)', () => {
    it.each([[NaN], ['abc'], [''], [null], [Infinity]])('fetchRecentCommits(limit=%p) uses per_page=5', async (limit) => {
        global.fetch.mockResolvedValueOnce(ok([]));
        await new PullRequestService({ githubToken: 't' }).fetchRecentCommits(GH_PR, 'a.js', BASE, limit);
        expect(global.fetch.mock.calls[0][0]).toContain('per_page=5');
    });

    it.each([[NaN], ['abc'], [''], [null]])('fetchPriorPrComments(limitPrs=%p) scans the default 10 commits', async (limitPrs) => {
        global.fetch.mockResolvedValueOnce(ok([]));
        await new PullRequestService().fetchPriorPrComments(GH_PR, 'a.js', { limitPrs });
        expect(global.fetch.mock.calls[0][0]).toContain('per_page=10');
    });
});

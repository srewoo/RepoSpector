/**
 * Context fetches are the half of GHE support that fails silently: the review
 * still runs, the context is just empty, and nothing in the UI says so.
 *
 * `enhanceWithGitHubContext`'s owner/repo-extraction regex was previously
 * anchored to the literal substring `github.com` (the same pre-existing gap
 * noted in Task 6's report for the analogous `PullRequestService`/
 * `GitHubService` regexes) and never matched an enterprise host, which would
 * have made an enterprise-host assertion pass trivially without exercising
 * any fetch at all. That regex has since been fixed to route on the detected
 * host. The tests below assert the fetch layer is actually reached for an
 * enterprise host — the fetch URL is now built from `githubApiBase(sourceUrl)`
 * instead of a hardcoded `https://api.github.com` — first by calling
 * `fetchGitHubFiles` directly, then (further down) by going through
 * `enhanceWithGitHubContext`/`enhanceWithGitLabContext`/
 * `enhanceWithGitLabContextAPI` to also cover the extraction regex itself.
 */
const { setGitHubHosts, resetGitHubHosts, setGitLabHosts, resetGitLabHosts } = require('../../src/utils/gitHosts.js');

describe('contextAnalyzer host routing', () => {
    let fetchMock;

    beforeEach(() => {
        setGitHubHosts(['github.acme.com']);
        setGitLabHosts(['gitlab.acme.com']);
        fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ tree: [], content: '', encoding: 'utf-8' }),
            text: async () => '',
        });
        global.fetch = fetchMock;
    });

    afterEach(() => { resetGitHubHosts(); resetGitLabHosts(); jest.resetAllMocks(); });

    /** Every host a run touched, for asserting nothing leaked to the wrong one. */
    function hostsCalled() {
        return [...new Set(fetchMock.mock.calls.map(c => new URL(c[0]).host))];
    }

    it('never calls api.github.com for an enterprise source URL', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        const context = { tokenCount: 0, language: 'javascript' };
        await analyzer.fetchGitHubFiles(
            'o', 'r', 'main', ['src/index.js'], context,
            'https://github.acme.com/o/r/blob/main/src/index.js',
        );
        expect(hostsCalled()).not.toContain('api.github.com');
        expect(hostsCalled()).toContain('github.acme.com');
    });

    it('still calls api.github.com for a github.com source URL', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        const context = { tokenCount: 0, language: 'javascript' };
        await analyzer.fetchGitHubFiles(
            'o', 'r', 'main', ['src/index.js'], context,
            'https://github.com/o/r/blob/main/src/index.js',
        );
        expect(hostsCalled()).toContain('api.github.com');
    });

    /**
     * Finding 1 (from coordinator review): the owner/repo EXTRACTION regexes in
     * `enhanceWithGitHubContext`/`enhanceWithGitLabContext`/`enhanceWithGitLabContextAPI`
     * were still anchored to the literal `github.com`/`gitlab.com` substrings,
     * upstream of every fetch site routed above. That made the routing fix
     * unreachable in practice: a real GHE or self-hosted-GitLab URL would fail
     * the extraction regex and return before any fetch happened at all — the
     * fetch sites being correctly routed was irrelevant if they were never
     * reached. These two tests assert the fetch layer is actually reached
     * (not just that no fetch went to the wrong host, which a silent early
     * return would also satisfy trivially).
     */
    it('reaches the fetch layer for a registered GitHub Enterprise URL', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        const context = { imports: [], tokenCount: 0, language: 'javascript' };
        await analyzer.enhanceWithGitHubContext(
            context,
            'https://github.acme.com/o/r',
            'full',
        );
        expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
        expect(hostsCalled()).toContain('github.acme.com');
        expect(hostsCalled()).not.toContain('api.github.com');
    });

    it('reaches the fetch layer for a self-hosted GitLab URL with nested groups', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        const context = { imports: [], tokenCount: 0, language: 'javascript' };
        await analyzer.enhanceWithGitLabContextAPI(
            context,
            'https://gitlab.acme.com/g/sub/p/-/merge_requests/3',
            'full',
            'fake-token',
        );
        expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
        expect(hostsCalled()).toContain('gitlab.acme.com');
        expect(hostsCalled()).not.toContain('gitlab.com');
    });
});

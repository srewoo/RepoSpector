/**
 * A wrong API base fails in the most expensive way available: the request goes
 * to a real server that answers 404, so the error says "not found" rather than
 * "wrong host", and the user concludes their PR is unreadable.
 */
const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { LinkedIssueService } = require('../../src/services/LinkedIssueService.js');
const { setGitHubHosts, resetGitHubHosts, getGitHubHosts } = require('../../src/utils/gitHosts.js');
const { GitHubService } = require('../../src/services/GitHubService.js');

describe('PullRequestService API base resolution', () => {
    beforeEach(() => setGitHubHosts(['github.acme.com']));
    afterEach(() => resetGitHubHosts());

    it('resolves the enterprise base from a PR URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://github.acme.com/o/r/pull/7'))
            .toBe('https://github.acme.com/api/v3');
    });

    it('resolves the public base from a github.com URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://github.com/o/r/pull/7'))
            .toBe('https://api.github.com');
    });

    it('resolves a self-hosted GitLab base from an MR URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://gitlab.acme.com/g/p/-/merge_requests/3'))
            .toBe('https://gitlab.acme.com/api/v4');
    });

    it('falls back to the public bases when given no URL', () => {
        const svc = new PullRequestService();
        expect(svc.githubBaseUrl).toBe('https://api.github.com');
        expect(svc.gitlabBaseUrl).toBe('https://gitlab.com/api/v4');
    });
});

describe('PullRequestService.parsePullRequestUrl GitHub gating', () => {
    beforeEach(() => setGitHubHosts(['github.acme.com']));
    afterEach(() => resetGitHubHosts());

    it('parses a github.com PR URL unchanged', () => {
        const svc = new PullRequestService();
        const info = svc.parsePullRequestUrl('https://github.com/o/r/pull/4');
        expect(info).toMatchObject({
            platform: 'github',
            owner: 'o',
            repo: 'r',
            prNumber: 4,
            apiBase: 'https://api.github.com',
        });
    });

    it('parses a registered GHE PR URL with a /api/v3 apiBase', () => {
        const svc = new PullRequestService();
        const info = svc.parsePullRequestUrl('https://github.acme.com/o/r/pull/4');
        expect(info).toMatchObject({
            platform: 'github',
            owner: 'o',
            repo: 'r',
            prNumber: 4,
            apiBase: 'https://github.acme.com/api/v3',
        });
    });

    it('returns null for an UNregistered enterprise host', () => {
        resetGitHubHosts();
        const svc = new PullRequestService();
        expect(svc.parsePullRequestUrl('https://github.unregistered.example/o/r/pull/4')).toBeNull();
    });

    it('returns null for a Codeberg PR-shaped URL', () => {
        const svc = new PullRequestService();
        expect(svc.parsePullRequestUrl('https://codeberg.org/o/r/pull/4')).toBeNull();
    });

    it('still parses a GitLab MR URL as gitlab, not github', () => {
        const svc = new PullRequestService();
        const info = svc.parsePullRequestUrl('https://gitlab.acme.com/g/p/-/merge_requests/3');
        expect(info.platform).toBe('gitlab');
    });
});

describe('GitHubService.parseGitHubUrl host gating', () => {
    beforeEach(() => resetGitHubHosts());
    afterEach(() => resetGitHubHosts());

    it('parses github.com unchanged', () => {
        const svc = new GitHubService();
        const parsed = svc.parseGitHubUrl('https://github.com/o/r');
        expect(parsed).toMatchObject({ owner: 'o', repo: 'r' });
        expect(getGitHubHosts()).toEqual(['github.com']);
    });

    it('returns null for a Codeberg URL and does not poison the host list', () => {
        const svc = new GitHubService();
        const before = getGitHubHosts();
        expect(svc.parseGitHubUrl('https://codeberg.org/o/r')).toBeNull();
        expect(getGitHubHosts()).toEqual(before);
        expect(getGitHubHosts()).toEqual(['github.com']);
    });

    it('returns null for an unregistered enterprise host and does not poison the host list', () => {
        const svc = new GitHubService();
        expect(svc.parseGitHubUrl('https://github.unregistered.example/o/r')).toBeNull();
        expect(getGitHubHosts()).toEqual(['github.com']);
    });

    it('still parses a registered enterprise host, with an /api/v3 apiBase', () => {
        setGitHubHosts(['github.acme.com']);
        const svc = new GitHubService();
        const parsed = svc.parseGitHubUrl('https://github.acme.com/o/r');
        expect(parsed).toMatchObject({
            owner: 'o',
            repo: 'r',
            host: 'github.acme.com',
            apiBase: 'https://github.acme.com/api/v3',
        });
    });
});

describe('LinkedIssueService API base resolution', () => {
    beforeEach(() => setGitHubHosts(['github.acme.com']));
    afterEach(() => resetGitHubHosts());

    it('honours an explicit override before falling back to the URL', () => {
        const svc = new LinkedIssueService({ githubBaseUrl: 'https://override.example/api/v3' });
        expect(svc.githubBaseUrl).toBe('https://override.example/api/v3');
    });

    it('resolves the enterprise base from an issue URL', () => {
        const svc = new LinkedIssueService();
        expect(svc.resolveGitHubBase('https://github.acme.com/o/r/issues/2'))
            .toBe('https://github.acme.com/api/v3');
    });
});

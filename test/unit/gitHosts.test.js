/**
 * Self-hosted GitLab.
 *
 * Platform detection used to be `url.includes('gitlab.com')`, so an MR on a
 * company instance was classified as GitHub and then 404'd against
 * api.github.com. These tests pin both halves of the fix: structural detection
 * (works with no configuration) and the per-instance API base.
 */

const {
    detectPlatform,
    detectPlatformOrGitHub,
    gitlabApiBase,
    isKnownGitLabHost,
    setGitLabHosts,
    rememberGitLabHost,
    getGitLabHosts,
    resetGitLabHosts,
    hostOf,
} = require('../../src/utils/gitHosts.js');

const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { GitLabService } = require('../../src/services/GitLabService.js');

beforeEach(() => resetGitLabHosts());

describe('detectPlatform', () => {
    it('recognises github.com pull requests', () => {
        expect(detectPlatform('https://github.com/o/r/pull/1')).toBe('github');
    });

    it('recognises gitlab.com merge requests', () => {
        expect(detectPlatform('https://gitlab.com/g/p/-/merge_requests/7')).toBe('gitlab');
    });

    it('recognises an MR on an UNCONFIGURED self-hosted host', () => {
        // The whole point: no prior setup, structure alone identifies it.
        expect(detectPlatform('https://gitlab.acme.internal/team/svc/-/merge_requests/42')).toBe('gitlab');
    });

    it('recognises a self-hosted repo URL once the host is configured', () => {
        const repo = 'https://git.acme.dev/team/svc';
        expect(detectPlatform(repo)).toBeNull();   // no marker, not yet known
        setGitLabHosts('git.acme.dev');
        expect(detectPlatform(repo)).toBe('gitlab');
    });

    it('returns null for an unrelated URL instead of guessing GitHub', () => {
        expect(detectPlatform('https://example.com/some/page')).toBeNull();
    });

    it('detectPlatformOrGitHub keeps the historical default for callers with no null branch', () => {
        expect(detectPlatformOrGitHub('https://example.com/x')).toBe('github');
    });
});

describe('host configuration', () => {
    it('always keeps gitlab.com, whatever else is configured', () => {
        setGitLabHosts(['git.acme.dev']);
        expect(getGitLabHosts()).toEqual(expect.arrayContaining(['gitlab.com', 'git.acme.dev']));
    });

    it('accepts a full URL where a hostname was expected', () => {
        setGitLabHosts('https://git.acme.dev/group/project');
        expect(isKnownGitLabHost('git.acme.dev')).toBe(true);
    });

    it('matches subdomains of a configured host', () => {
        setGitLabHosts('acme.dev');
        expect(isKnownGitLabHost('gitlab.acme.dev')).toBe(true);
        expect(isKnownGitLabHost('acme.dev.evil.com')).toBe(false);
    });

    it('does not treat an unrelated host as GitLab', () => {
        setGitLabHosts('git.acme.dev');
        expect(isKnownGitLabHost('gitlab.other.com')).toBe(false);
    });

    it('learns a host from a parsed MR URL', () => {
        rememberGitLabHost('https://gitlab.acme.internal/x/y/-/merge_requests/1');
        expect(isKnownGitLabHost('gitlab.acme.internal')).toBe(true);
    });

    it('hostOf tolerates a bare hostname', () => {
        expect(hostOf('git.acme.dev')).toBe('git.acme.dev');
        expect(hostOf('')).toBeNull();
    });
});

describe('gitlabApiBase', () => {
    it('defaults to the public instance', () => {
        expect(gitlabApiBase()).toBe('https://gitlab.com/api/v4');
    });

    it('derives the API root from any URL on the instance', () => {
        expect(gitlabApiBase('https://gitlab.acme.internal/g/p/-/merge_requests/3'))
            .toBe('https://gitlab.acme.internal/api/v4');
    });

    it('preserves a non-default port', () => {
        expect(gitlabApiBase('https://gitlab.acme.internal:8443/g/p'))
            .toBe('https://gitlab.acme.internal:8443/api/v4');
    });

    it('preserves an http-only internal instance', () => {
        expect(gitlabApiBase('http://gitlab.local/g/p')).toBe('http://gitlab.local/api/v4');
    });
});

describe('PullRequestService.parsePullRequestUrl', () => {
    const svc = new PullRequestService();

    it('parses a self-hosted MR and targets that instance', () => {
        const info = svc.parsePullRequestUrl('https://gitlab.acme.internal/team/svc/-/merge_requests/42');
        expect(info).toMatchObject({
            platform: 'gitlab',
            host: 'gitlab.acme.internal',
            projectPath: 'team/svc',
            repo: 'svc',
            mrNumber: 42,
        });
        expect(svc.gitlabApiFor(info)).toBe('https://gitlab.acme.internal/api/v4');
    });

    it('still parses nested groups, on any host', () => {
        const info = svc.parsePullRequestUrl('https://gitlab.com/group/sub/deep/proj/-/merge_requests/9');
        expect(info.projectPath).toBe('group/sub/deep/proj');
        expect(info.owner).toBe('group/sub/deep');
        expect(info.repo).toBe('proj');
        expect(info.mrNumber).toBe(9);
    });

    it('keeps GitHub URLs on the GitHub path', () => {
        expect(svc.parsePullRequestUrl('https://github.com/o/r/pull/3').platform).toBe('github');
    });

    it('falls back to the public API base for a hand-built prInfo', () => {
        expect(svc.gitlabApiFor({ projectPath: 'a/b' })).toBe('https://gitlab.com/api/v4');
    });
});

describe('GitLabService.parseGitLabUrl', () => {
    const svc = new GitLabService();

    it('parses a self-hosted repo URL and its API base', () => {
        const parsed = svc.parseGitLabUrl('https://gitlab.acme.internal/team/svc');
        expect(parsed.projectPath).toBe('team/svc');
        expect(parsed.apiBase).toBe('https://gitlab.acme.internal/api/v4');
    });

    it('reads the branch out of a self-hosted tree URL', () => {
        const parsed = svc.parseGitLabUrl('https://gitlab.acme.internal/team/svc/-/tree/develop');
        expect(parsed).toMatchObject({ projectPath: 'team/svc', branch: 'develop' });
    });
});

describe('postGitLabReview targets the right instance', () => {
    afterEach(() => { delete global.fetch; });

    it('posts to the self-hosted API, not gitlab.com', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 1 }),
        });

        const svc = new PullRequestService({ gitlabToken: 'tok' });
        const prInfo = svc.parsePullRequestUrl('https://gitlab.acme.internal/team/svc/-/merge_requests/42');

        await svc.postGitLabReview(prInfo, { summary: 'hello', inlineComments: [] });

        expect(global.fetch.mock.calls[0][0]).toContain('https://gitlab.acme.internal/api/v4/');
        expect(global.fetch.mock.calls[0][0]).not.toContain('gitlab.com');
    });
});

describe('parseRepoRef', () => {
    const { parseRepoRef, setGitLabHosts, resetGitLabHosts } = require('../../src/utils/gitHosts.js');

    afterEach(() => resetGitLabHosts());

    it('parses a GitHub PR URL', () => {
        const r = parseRepoRef('https://github.com/acme/widgets/pull/42');
        expect(r).toMatchObject({
            platform: 'github', owner: 'acme', repo: 'widgets', projectPath: 'acme/widgets',
        });
    });

    it('strips a .git suffix', () => {
        expect(parseRepoRef('https://github.com/acme/widgets.git').repo).toBe('widgets');
    });

    it('parses a gitlab.com MR URL', () => {
        const r = parseRepoRef('https://gitlab.com/acme/widgets/-/merge_requests/7');
        expect(r).toMatchObject({ platform: 'gitlab', repo: 'widgets', projectPath: 'acme/widgets' });
    });

    it('keeps the full project path for a GitLab SUBGROUP', () => {
        // The old regex took exactly two path segments, so this parsed as
        // owner=platform, repo=payments and the config fetch 404'd against a
        // project that does not exist. Nested groups are the norm in enterprise.
        const r = parseRepoRef('https://gitlab.com/platform/payments/billing-api/-/merge_requests/7');
        expect(r.projectPath).toBe('platform/payments/billing-api');
        expect(r.repo).toBe('billing-api');
        expect(r.owner).toBe('platform/payments');
    });

    it('parses a SELF-HOSTED GitLab MR URL by route structure alone', () => {
        // The old regex hardcoded github.com|gitlab.com, so .repospector.yaml was
        // silently unavailable on every internal instance — no custom rules, no
        // model pin, no severity floor, no cross-repo workspace.
        const r = parseRepoRef('https://gitlab.internal.acme.com/team/svc/-/merge_requests/3');
        expect(r).toMatchObject({
            platform: 'gitlab', projectPath: 'team/svc', host: 'gitlab.internal.acme.com',
        });
    });

    it('parses a self-hosted subgroup MR URL', () => {
        const r = parseRepoRef('https://git.acme.io/eng/platform/core/-/merge_requests/99');
        expect(r.projectPath).toBe('eng/platform/core');
    });

    it('handles a legacy MR URL without the /-/ separator', () => {
        const r = parseRepoRef('https://gitlab.com/acme/widgets/merge_requests/7');
        expect(r.projectPath).toBe('acme/widgets');
    });

    it('parses a configured self-hosted repo URL that carries no route marker', () => {
        setGitLabHosts(['git.acme.io']);
        const r = parseRepoRef('https://git.acme.io/eng/core');
        expect(r).toMatchObject({ platform: 'gitlab', projectPath: 'eng/core' });
    });

    it('returns null rather than guessing GitHub for an unknown host', () => {
        expect(parseRepoRef('https://bitbucket.org/acme/widgets')).toBeNull();
    });

    it('returns null for unusable input', () => {
        expect(parseRepoRef('')).toBeNull();
        expect(parseRepoRef(null)).toBeNull();
        expect(parseRepoRef('https://github.com/acme')).toBeNull();
        expect(parseRepoRef('not a url at all ///')).toBeNull();
    });
});

const {
    githubApiBase,
    githubRawBase,
    setGitHubHosts,
    rememberGitHubHost,
    getGitHubHosts,
    resetGitHubHosts,
    isKnownGitHubHost,
} = require('../../src/utils/gitHosts.js');

describe('githubApiBase', () => {
    afterEach(() => resetGitHubHosts());

    it('maps the public instance to api.github.com', () => {
        expect(githubApiBase('https://github.com/o/r/pull/1')).toBe('https://api.github.com');
        expect(githubApiBase()).toBe('https://api.github.com');
    });

    it('maps an enterprise host to its /api/v3 root', () => {
        expect(githubApiBase('https://github.acme.com/o/r/pull/1')).toBe('https://github.acme.com/api/v3');
    });

    it('preserves a non-default port and an http scheme', () => {
        expect(githubApiBase('http://ghe.internal:8080/o/r')).toBe('http://ghe.internal:8080/api/v3');
    });
});

describe('githubRawBase', () => {
    it('maps the public instance to raw.githubusercontent.com', () => {
        expect(githubRawBase('https://github.com/o/r')).toBe('https://raw.githubusercontent.com');
    });

    it('serves raw content from the enterprise host itself', () => {
        expect(githubRawBase('https://github.acme.com/o/r')).toBe('https://github.acme.com');
    });
});

describe('GitHub host configuration', () => {
    afterEach(() => resetGitHubHosts());

    it('always retains github.com', () => {
        setGitHubHosts(['github.acme.com']);
        expect(getGitHubHosts()).toContain('github.com');
        expect(getGitHubHosts()).toContain('github.acme.com');
    });

    it('accepts a full URL as well as a bare host', () => {
        setGitHubHosts(['https://github.acme.com/o/r/pull/3']);
        expect(isKnownGitHubHost('github.acme.com')).toBe(true);
    });

    it('matches subdomains of a configured suffix', () => {
        setGitHubHosts(['acme.com']);
        expect(isKnownGitHubHost('github.acme.com')).toBe(true);
    });

    it('does not match an unconfigured host', () => {
        expect(isKnownGitHubHost('github.other.com')).toBe(false);
    });

    it('remembers a host discovered at runtime', () => {
        rememberGitHubHost('https://ghe.acme.com/o/r/pull/9');
        expect(isKnownGitHubHost('ghe.acme.com')).toBe(true);
    });
});

describe('detectPlatform with GHE', () => {
    afterEach(() => { resetGitHubHosts(); resetGitLabHosts(); });

    it('detects a configured enterprise host as github', () => {
        setGitHubHosts(['github.acme.com']);
        expect(detectPlatform('https://github.acme.com/o/r/pull/4')).toBe('github');
    });

    it('returns null for an unconfigured enterprise host', () => {
        // Configuration-only by design: /pull/<n> is also Gitea's and
        // Codeberg's shape, so inferring GitHub from it would misroute them.
        expect(detectPlatform('https://github.acme.com/o/r/pull/4')).toBeNull();
    });

    it('still returns null for other forges', () => {
        expect(detectPlatform('https://codeberg.org/o/r/pulls/4')).toBeNull();
    });

    it('lets a GitLab route win on a host configured as both', () => {
        setGitHubHosts(['devtools.acme.com']);
        setGitLabHosts(['devtools.acme.com']);
        expect(detectPlatform('https://devtools.acme.com/g/p/-/merge_requests/7')).toBe('gitlab');
    });

    it('leaves github.com behaviour unchanged', () => {
        expect(detectPlatform('https://github.com/o/r/pull/1')).toBe('github');
    });
});

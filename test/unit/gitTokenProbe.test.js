/**
 * The amber tier is the point of this classifier. A GitHub token without the
 * "repo" scope authenticates cleanly and then fails on the first private
 * repository, so a green verdict there would promise a review that cannot run.
 * Equally, a fine-grained PAT reports NO scopes at all, so an empty scope
 * header must never be read as "missing scope" — that would fire amber on
 * every modern token and train users to ignore it.
 */
const {
    GIT_PLATFORM,
    SCOPE_INSUFFICIENT,
    classifyGitTokenProbe,
    githubScopeCovers,
} = require('../../src/utils/gitTokenProbe.js');
const { PROBE_STATE } = require('../../src/utils/apiKeyProbe.js');

describe('githubScopeCovers', () => {
    test('true when repo scope is present among others', () => {
        expect(githubScopeCovers('gist, repo, read:org')).toBe(true);
    });

    test('false when a real scope list omits repo', () => {
        expect(githubScopeCovers('gist, read:org')).toBe(false);
    });

    test('null when undeterminable — absent or empty header (fine-grained PAT)', () => {
        expect(githubScopeCovers(null)).toBeNull();
        expect(githubScopeCovers(undefined)).toBeNull();
        expect(githubScopeCovers('')).toBeNull();
        expect(githubScopeCovers('   ')).toBeNull();
        expect(githubScopeCovers(',  ,')).toBeNull();
    });

    test('does not match a scope that merely contains "repo"', () => {
        expect(githubScopeCovers('public_repo')).toBe(false);
        expect(githubScopeCovers('repo:status')).toBe(false);
    });
});

describe('classifyGitTokenProbe — success', () => {
    test('200 is OK and names who the token belongs to', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITLAB, status: 200, identity: 'sharaj',
        });
        expect(r.state).toBe(PROBE_STATE.OK);
        expect(r.keyProven).toBe(true);
        expect(r.message).toContain('sharaj');
    });

    test('200 without an identity still reads as verified', () => {
        const r = classifyGitTokenProbe({ platform: GIT_PLATFORM.JIRA, status: 200 });
        expect(r.state).toBe(PROBE_STATE.OK);
        expect(r.message).toMatch(/verified/i);
    });

    test('a fine-grained GitHub PAT (no scope header) is OK, not amber', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITHUB, status: 200, identity: 'octocat', scopeHeader: '',
        });
        expect(r.state).toBe(PROBE_STATE.OK);
    });
});

describe('classifyGitTokenProbe — the amber tier', () => {
    test('GitHub 200 without repo scope is amber, not green', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITHUB, status: 200, identity: 'octocat',
            scopeHeader: 'gist, read:org',
        });
        expect(r.state).toBe(SCOPE_INSUFFICIENT);
        expect(r.keyProven).toBe(true);
        expect(r.message).toContain('repo');
        expect(r.message).toContain('private');
    });

    test('scope is only checked for GitHub — GitLab 200 stays green', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITLAB, status: 200, scopeHeader: 'gist',
        });
        expect(r.state).toBe(PROBE_STATE.OK);
    });

    test('403 with exhausted rate limit is throttling, not a bad token', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITHUB, status: 403, rateLimitRemaining: '0',
        });
        expect(r.state).toBe(PROBE_STATE.RATE_LIMITED);
        expect(r.keyProven).toBe(true);
    });

    test('403 with quota left is under-scoped or SSO-gated, and keyProven', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITHUB, status: 403, rateLimitRemaining: '4999',
        });
        expect(r.state).toBe(SCOPE_INSUFFICIENT);
        expect(r.keyProven).toBe(true);
        expect(r.message).toMatch(/SSO|scope/i);
    });

    test('403 with no rate-limit header is treated as forbidden, not throttled', () => {
        const r = classifyGitTokenProbe({ platform: GIT_PLATFORM.GITLAB, status: 403 });
        expect(r.state).toBe(SCOPE_INSUFFICIENT);
    });
});

describe('classifyGitTokenProbe — rejection and reachability', () => {
    test('401 is a rejected credential, never keyProven', () => {
        for (const platform of Object.values(GIT_PLATFORM)) {
            const r = classifyGitTokenProbe({ platform, status: 401 });
            expect(r.state).toBe(PROBE_STATE.KEY_INVALID);
            expect(r.keyProven).toBe(false);
        }
    });

    test('Jira 401 names the email as a likely cause, since it is a paired credential', () => {
        const r = classifyGitTokenProbe({ platform: GIT_PLATFORM.JIRA, status: 401 });
        expect(r.message).toMatch(/email/i);
    });

    test('a thrown request is unreachable, NOT an invalid token', () => {
        const r = classifyGitTokenProbe({
            platform: GIT_PLATFORM.GITHUB, status: null, networkError: 'Failed to fetch',
        });
        expect(r.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(r.keyProven).toBe(false);
        expect(r.message).toContain('Failed to fetch');
    });

    test('Jira 404 blames the site URL, not the token', () => {
        const r = classifyGitTokenProbe({ platform: GIT_PLATFORM.JIRA, status: 404 });
        expect(r.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(r.message).toMatch(/atlassian\.net|site URL/i);
        expect(r.message).not.toMatch(/token .*(expired|revoked)/i);
    });

    test('an unexpected status degrades to unreachable and reports the code', () => {
        const r = classifyGitTokenProbe({ platform: GIT_PLATFORM.GITLAB, status: 500 });
        expect(r.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(r.message).toContain('500');
    });

    test('every outcome carries a non-empty message and a boolean keyProven', () => {
        const cases = [
            { platform: GIT_PLATFORM.GITHUB, status: 200 },
            { platform: GIT_PLATFORM.GITHUB, status: 200, scopeHeader: 'gist' },
            { platform: GIT_PLATFORM.GITHUB, status: 401 },
            { platform: GIT_PLATFORM.GITHUB, status: 403 },
            { platform: GIT_PLATFORM.GITHUB, status: 403, rateLimitRemaining: '0' },
            { platform: GIT_PLATFORM.GITLAB, status: 200 },
            { platform: GIT_PLATFORM.JIRA, status: 404 },
            { platform: GIT_PLATFORM.JIRA, status: null, networkError: 'boom' },
            { platform: GIT_PLATFORM.JIRA, status: 418 },
        ];
        for (const c of cases) {
            const r = classifyGitTokenProbe(c);
            expect(typeof r.message).toBe('string');
            expect(r.message.length).toBeGreaterThan(0);
            expect(typeof r.keyProven).toBe('boolean');
            expect(typeof r.state).toBe('string');
        }
    });
});

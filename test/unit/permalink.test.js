/**
 * Permalinks pin a finding to the reviewed commit. A link that drifts with the
 * branch, or points past the end of the file, sends the reader to the wrong
 * code — so a bad SHA yields no link at all, and ranges are clamped.
 */

const { buildPermalink, attachPermalinks, parseRepoUrl } = require('../../src/review-core/permalink.js');
const { setGitHubHosts, resetGitHubHosts } = require('../../src/utils/gitHosts.js');

const SHA = 'a'.repeat(40);

describe('buildPermalink', () => {
    it('builds a GitHub link with one line of context each side', () => {
        expect(buildPermalink({ platform: 'github', host: 'github.com', projectPath: 'o/r', headSha: SHA, path: 'src/a.js', startLine: 10 }))
            .toBe(`https://github.com/o/r/blob/${SHA}/src/a.js#L9-L11`);
    });

    it('builds a GHE link on the enterprise host', () => {
        expect(buildPermalink({ platform: 'github', host: 'ghe.acme.com', projectPath: 'o/r', headSha: SHA, path: 'a.js', startLine: 5, endLine: 7 }))
            .toBe(`https://ghe.acme.com/o/r/blob/${SHA}/a.js#L4-L8`);
    });

    it('builds a gitlab.com link for a nested group', () => {
        expect(buildPermalink({ platform: 'gitlab', host: 'gitlab.com', projectPath: 'g/sub/p', headSha: SHA, path: 'lib/x.py', startLine: 3 }))
            .toBe(`https://gitlab.com/g/sub/p/-/blob/${SHA}/lib/x.py#L2-4`);
    });

    it('builds a self-hosted GitLab link, port kept', () => {
        expect(buildPermalink({ platform: 'gitlab', host: 'git.acme.io:8443', projectPath: 'team/p', headSha: SHA, path: 'a.go', startLine: 20, endLine: 22 }))
            .toBe(`https://git.acme.io:8443/team/p/-/blob/${SHA}/a.go#L19-23`);
    });

    it('clamps the start to line 1 and the end to the file length', () => {
        expect(buildPermalink({ platform: 'github', host: 'github.com', projectPath: 'o/r', headSha: SHA, path: 'a.js', startLine: 1, endLine: 12, fileLength: 12 }))
            .toBe(`https://github.com/o/r/blob/${SHA}/a.js#L1-L12`);
    });

    it('ignores an endLine before the start line', () => {
        expect(buildPermalink({ platform: 'github', host: 'github.com', projectPath: 'o/r', headSha: SHA, path: 'a.js', startLine: 8, endLine: 2 }))
            .toBe(`https://github.com/o/r/blob/${SHA}/a.js#L7-L9`);
    });

    it('encodes path segments but keeps slashes', () => {
        expect(buildPermalink({ platform: 'github', host: 'github.com', projectPath: 'o/r', headSha: SHA, path: 'docs/my file#1.md', startLine: 2 }))
            .toBe(`https://github.com/o/r/blob/${SHA}/docs/my%20file%231.md#L1-L3`);
    });

    it.each([
        ['short sha', { headSha: 'abc123' }],
        ['missing sha', { headSha: null }],
        ['branch name', { headSha: 'main' }],
        ['no line', { startLine: undefined }],
        ['line 0', { startLine: 0 }],
        ['unknown platform', { platform: 'bitbucket' }],
    ])('returns null for %s', (_label, override) => {
        expect(buildPermalink({ platform: 'github', host: 'github.com', projectPath: 'o/r', headSha: SHA, path: 'a.js', startLine: 4, ...override }))
            .toBeNull();
    });
});

describe('attachPermalinks', () => {
    it('adds a permalink to each finding without mutating the input', () => {
        const findings = [
            { file: 'a.js', line: 4 },
            { filePath: 'b.js', line: 50, endLine: 52 },
            { title: 'no location' },
        ];
        const out = attachPermalinks(findings, {
            platform: 'gitlab', host: 'gitlab.com', projectPath: 'g/p', headSha: SHA, fileLengths: { 'b.js': 52 },
        });

        expect(out[0].permalink).toBe(`https://gitlab.com/g/p/-/blob/${SHA}/a.js#L3-5`);
        expect(out[1].permalink).toBe(`https://gitlab.com/g/p/-/blob/${SHA}/b.js#L49-52`);
        expect(out[2].permalink).toBeNull();
        expect(findings[0].permalink).toBeUndefined();
    });
});

describe('parseRepoUrl', () => {
    afterEach(() => resetGitHubHosts());

    it('parses a github.com PR URL', () => {
        expect(parseRepoUrl('https://github.com/o/r/pull/7')).toEqual({ platform: 'github', host: 'github.com', projectPath: 'o/r' });
    });

    it('parses a self-hosted GitLab MR URL with nested groups and a port', () => {
        expect(parseRepoUrl('https://git.acme.io:8443/a/b/c/-/merge_requests/3'))
            .toEqual({ platform: 'gitlab', host: 'git.acme.io:8443', projectPath: 'a/b/c' });
    });

    it('parses a GHE URL once the host is configured, and not before', () => {
        expect(parseRepoUrl('https://ghe.acme.com/o/r/pull/1')).toBeNull();
        setGitHubHosts(['ghe.acme.com']);
        expect(parseRepoUrl('https://ghe.acme.com/o/r/pull/1')).toEqual({ platform: 'github', host: 'ghe.acme.com', projectPath: 'o/r' });
    });

    it('parses a bare repo URL', () => {
        expect(parseRepoUrl('https://github.com/o/r')).toEqual({ platform: 'github', host: 'github.com', projectPath: 'o/r' });
    });

    it('returns null for junk', () => {
        expect(parseRepoUrl('not a url')).toBeNull();
        expect(parseRepoUrl('')).toBeNull();
    });
});

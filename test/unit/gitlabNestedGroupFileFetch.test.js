/**
 * Regression test for a shipped defect:
 *
 * `fetchFullFileContent`'s GitLab branch built the project id from
 * `${prInfo.owner}/${prInfo.repo}` instead of preferring `prInfo.projectPath`
 * (the pattern every other GitLab call in PullRequestService.js uses). For a
 * GitLab project in a nested group — e.g.
 * https://gitlab.com/mindtickle/qa-automation/jirashastra-mcp/-/merge_requests/96 —
 * `owner`/`repo` only carries the last two path segments, so the request hit
 * a project id that does not exist and every file fetch 404'd.
 */

const { PullRequestService } = require('../../src/services/PullRequestService.js');

const textResponse = (body, ok = true, status = 200) => ({
    ok,
    status,
    text: async () => body,
    statusText: ok ? 'OK' : 'Error',
});

describe('fetchFullFileContent - GitLab nested group project path', () => {
    let svc;

    beforeEach(() => {
        svc = new PullRequestService({ gitlabToken: 'tok' });
        global.fetch = jest.fn().mockResolvedValue(textResponse('file content'));
    });

    afterEach(() => {
        delete global.fetch;
    });

    it('requests the full three-segment project path for a nested group MR', async () => {
        const url = 'https://gitlab.com/a/b/c/-/merge_requests/1';
        await svc.fetchFullFileContent(url, 'src/index.js', 'feature-branch');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const requestedUrl = global.fetch.mock.calls[0][0];
        expect(requestedUrl).toContain('/projects/a%2Fb%2Fc/');
        expect(requestedUrl).not.toContain('/projects/b%2Fc/');
    });

    it('still requests the two-segment project path for a single-group MR', async () => {
        const url = 'https://gitlab.com/a/b/-/merge_requests/1';
        await svc.fetchFullFileContent(url, 'src/index.js', 'feature-branch');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const requestedUrl = global.fetch.mock.calls[0][0];
        expect(requestedUrl).toContain('/projects/a%2Fb/');
    });
});

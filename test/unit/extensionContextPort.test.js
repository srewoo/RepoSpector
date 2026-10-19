/**
 * The extension context port turns PullRequestService calls into the
 * review-core ContextPort contract: always resolves, a failure is a `not-run`
 * with the reason, and each question is asked once per review.
 */

const { createExtensionContextPort } = require('../../src/services/adapters/extensionContextPort.js');

const prData = { number: 42, baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };
const prUrl = 'https://github.com/o/r/pull/42';

function mockService(overrides = {}) {
    return {
        fetchBlame: jest.fn().mockResolvedValue([{ start: 1, end: 3, sha: 's', message: 'm', date: 'd' }]),
        fetchRecentCommits: jest.fn().mockResolvedValue([{ sha: 's', message: 'fix: x', date: 'd' }]),
        fetchPriorPrComments: jest.fn().mockResolvedValue([{ path: 'a.js', prRef: '#7', author: 'u', body: 'b', line: 3 }]),
        fetchFullFileContent: jest.fn().mockResolvedValue({ content: 'file text', filePath: 'a.js' }),
        ...overrides,
    };
}

describe('createExtensionContextPort', () => {
    it('wraps each service call in an ok result, defaulting refs from prData', async () => {
        const svc = mockService();
        const port = createExtensionContextPort({ prData, prUrl, pullRequestService: svc });

        expect(await port.blame('a.js', { startLine: 1, endLine: 3 }))
            .toEqual({ status: 'ok', ranges: [{ start: 1, end: 3, sha: 's', message: 'm', date: 'd' }] });
        expect(svc.fetchBlame).toHaveBeenCalledWith(prUrl, 'a.js', prData.baseSha, 1, 3);

        expect((await port.recentCommits('a.js', { limit: 3 })).commits).toHaveLength(1);
        expect(svc.fetchRecentCommits).toHaveBeenCalledWith(prUrl, 'a.js', prData.baseSha, 3);

        expect((await port.priorPrComments('a.js', { limitPrs: 2 })).comments[0].prRef).toBe('#7');
        expect(svc.fetchPriorPrComments).toHaveBeenCalledWith(prUrl, 'a.js', { limitPrs: 2, excludeNumber: 42 });

        expect(await port.fileContent('a.js')).toEqual({ status: 'ok', text: 'file text' });
        expect(svc.fetchFullFileContent).toHaveBeenCalledWith(prUrl, 'a.js', prData.headSha);
    });

    it('turns a thrown error into not-run with the reason', async () => {
        const svc = mockService({ fetchBlame: jest.fn().mockRejectedValue(new Error('GitHub blame needs a GitHub token')) });
        const port = createExtensionContextPort({ prData, prUrl, pullRequestService: svc });
        expect(await port.blame('a.js', { startLine: 1, endLine: 2 }))
            .toEqual({ status: 'not-run', reason: 'blame: GitHub blame needs a GitHub token' });
    });

    it('asks each question once per port, even concurrently', async () => {
        const svc = mockService();
        const port = createExtensionContextPort({ prData, prUrl, pullRequestService: svc });
        await Promise.all([port.recentCommits('a.js'), port.recentCommits('a.js')]);
        await port.recentCommits('a.js');
        expect(svc.fetchRecentCommits).toHaveBeenCalledTimes(1);
        await port.recentCommits('b.js');
        expect(svc.fetchRecentCommits).toHaveBeenCalledTimes(2);
    });

    it('does not share a cache between ports (one review each)', async () => {
        const svc = mockService();
        await createExtensionContextPort({ prData, prUrl, pullRequestService: svc }).fileContent('a.js');
        await createExtensionContextPort({ prData, prUrl, pullRequestService: svc }).fileContent('a.js');
        expect(svc.fetchFullFileContent).toHaveBeenCalledTimes(2);
    });

    it('reports not-run without calling anything when there is no PR URL', async () => {
        const svc = mockService();
        const port = createExtensionContextPort({ prData, pullRequestService: svc });
        expect(await port.priorPrComments('a.js')).toEqual({
            status: 'not-run', reason: 'prior PR comments: no PR URL or pull-request service',
        });
        expect(svc.fetchPriorPrComments).not.toHaveBeenCalled();
    });

    it('reports not-run for blame when the base SHA is unknown', async () => {
        const port = createExtensionContextPort({ prData: {}, prUrl, pullRequestService: mockService() });
        expect(await port.blame('a.js', {})).toEqual({ status: 'not-run', reason: 'blame: base SHA unknown' });
    });
});

/**
 * Pipeline status normalisation (spec §4.2).
 *
 * SkipRuleEngine's `DEFER failing_pipeline` rule read `pr.pipelineStatus`,
 * which nothing set: GitLab wrote `pipeline.status`, GitHub wrote nothing. These
 * tests pin the one vocabulary and that both hosts now populate it.
 */
const { normalizePipelineStatus, PIPELINE_STATUS } = require('../../src/utils/pipelineStatus.js');
const { PullRequestService } = require('../../src/services/PullRequestService.js');

describe('normalizePipelineStatus — strings', () => {
    it.each([
        ['success', 'success'], ['passed', 'success'],
        ['failed', 'failed'], ['failing', 'failed'], ['error', 'failed'],
        ['canceled', 'failed'], ['FAILED', 'failed'],
        ['running', 'running'], ['pending', 'running'], ['created', 'running'],
        ['waiting_for_resource', 'running'], ['preparing', 'running'], ['scheduled', 'running'],
        ['skipped', 'none'], ['manual', 'none'], ['', 'none'], [null, 'none'], [undefined, 'none'],
        ['none', 'none'],
    ])('%p → %p', (raw, expected) => {
        expect(normalizePipelineStatus(raw)).toBe(expected);
    });
});

describe('normalizePipelineStatus — GitHub check runs', () => {
    const run = (status, conclusion = null) => ({ status, conclusion });

    it('no runs is none', () => {
        expect(normalizePipelineStatus([])).toBe(PIPELINE_STATUS.NONE);
    });
    it.each(['failure', 'timed_out', 'cancelled'])('any %s conclusion is failed', (c) => {
        expect(normalizePipelineStatus([run('completed', 'success'), run('completed', c)])).toBe('failed');
    });
    it('a failure wins over a still-running run', () => {
        expect(normalizePipelineStatus([run('in_progress'), run('completed', 'failure')])).toBe('failed');
    });
    it('any unfinished run with no failure is running', () => {
        expect(normalizePipelineStatus([run('completed', 'success'), run('queued')])).toBe('running');
    });
    it('all completed without failure is success (neutral/skipped do not fail)', () => {
        expect(normalizePipelineStatus([
            run('completed', 'success'), run('completed', 'neutral'), run('completed', 'skipped'),
        ])).toBe('success');
    });
});

const okJson = (body) => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
});
const fail = (status) => ({
    ok: false, status, statusText: 'nope',
    headers: { get: () => null },
    json: async () => ({}),
});

/** Route a fetch by URL substring; first match wins. */
function routeFetch(routes) {
    return jest.fn(async (url) => {
        for (const [needle, response] of routes) {
            if (String(url).includes(needle)) return response;
        }
        return okJson([]);
    });
}

describe('PullRequestService sets prData.pipelineStatus', () => {
    afterEach(() => { global.fetch = undefined; jest.restoreAllMocks(); });

    const ghPr = {
        id: 1, number: 5, title: 't', body: '', state: 'open', user: { login: 'dev' }, labels: [],
        head: { ref: 'f', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) },
    };
    const ghInfo = { owner: 'o', repo: 'r', prNumber: 5, apiBase: 'https://api.github.com' };

    it('GitHub: a failed check run on the head commit → failed', async () => {
        global.fetch = routeFetch([
            ['/check-runs', okJson({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })],
            ['/pulls/5/', okJson([])],
            ['/pulls/5', okJson(ghPr)],
        ]);
        const pr = await new PullRequestService({ githubToken: 't' }).fetchGitHubPR(ghInfo);
        expect(pr.pipelineStatus).toBe('failed');
        const checkUrl = global.fetch.mock.calls.map(c => c[0]).find(u => u.includes('/check-runs'));
        expect(checkUrl).toBe(`https://api.github.com/repos/o/r/commits/${'a'.repeat(40)}/check-runs?per_page=100`);
    });

    it('GitHub: unreadable check runs (403) → none with a reason, and the PR fetch still succeeds', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        global.fetch = routeFetch([
            ['/check-runs', fail(403)],
            ['/pulls/5/', okJson([])],
            ['/pulls/5', okJson(ghPr)],
        ]);
        const pr = await new PullRequestService({ githubToken: 't' }).fetchGitHubPR(ghInfo);
        expect(pr.pipelineStatus).toBe('none');
        expect(pr.pipelineStatusReason).toMatch(/checks_unreadable: .*403/);
        expect(pr.headSha).toBe('a'.repeat(40));
        expect(warn).toHaveBeenCalled();
    });

    it('GitHub: check-runs request rejects (network) → none with a reason, and the PR fetch still succeeds', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const inner = routeFetch([
            ['/pulls/5/', okJson([])],
            ['/pulls/5', okJson(ghPr)],
        ]);
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/check-runs')) throw new Error('socket hang up');
            return inner(url);
        });
        const pr = await new PullRequestService({ githubToken: 't' }).fetchGitHubPR(ghInfo);
        expect(pr.pipelineStatus).toBe('none');
        expect(pr.pipelineStatusReason).toMatch(/checks_unreadable: socket hang up/);
        expect(pr.headSha).toBe('a'.repeat(40));
        expect(warn).toHaveBeenCalled();
    });

    it('GitHub: readable check runs → no pipelineStatusReason', async () => {
        global.fetch = routeFetch([
            ['/check-runs', okJson({ check_runs: [{ status: 'completed', conclusion: 'success' }] })],
            ['/pulls/5/', okJson([])],
            ['/pulls/5', okJson(ghPr)],
        ]);
        const pr = await new PullRequestService({ githubToken: 't' }).fetchGitHubPR(ghInfo);
        expect(pr.pipelineStatus).toBe('success');
        expect(pr.pipelineStatusReason ?? null).toBeNull();
    });

    it('GitHub: normalizeGitHubPR without check runs → none (old call shape)', () => {
        const out = new PullRequestService().normalizeGitHubPR(ghPr, [], [], [], []);
        expect(out.pipelineStatus).toBe('none');
    });

    const mrBody = (head_pipeline) => ({
        id: 1, iid: 7, title: 'change', description: '', state: 'opened',
        author: { username: 'dev' }, source_branch: 'feat', target_branch: 'main',
        diff_refs: { head_sha: 'h', base_sha: 'b' }, labels: [], created_at: '', updated_at: '',
        web_url: 'https://gitlab.com/acme/web/-/merge_requests/7', head_pipeline,
    });

    it.each([
        [{ id: 9, status: 'failed' }, 'failed'],
        [{ id: 9, status: 'running' }, 'running'],
        [{ id: 9, status: 'success' }, 'success'],
        [null, 'none'],
    ])('GitLab: head_pipeline %p → %p', async (head_pipeline, expected) => {
        global.fetch = routeFetch([
            ['/changes', okJson({ changes: [] })],
            ['/notes', okJson([])],
            ['/commits', okJson([])],
            ['/approvals', okJson({})],
            ['/pipelines/', okJson([])],
            ['/merge_requests/7', okJson(mrBody(head_pipeline))],
        ]);
        const mr = await new PullRequestService({ gitlabToken: 't' })
            .fetchGitLabMR({ projectPath: 'acme/web', mrNumber: 7 });
        expect(mr.pipelineStatus).toBe(expected);
        // The raw shape stays for existing readers.
        expect(mr.pipeline?.status ?? null).toBe(head_pipeline?.status ?? null);
    });
});

describe('fetchCheckAnnotations still works through the shared check-runs helper', () => {
    afterEach(() => { global.fetch = undefined; });

    it('lists runs at per_page=10 and reads annotations', async () => {
        global.fetch = routeFetch([
            ['/check-runs/77/annotations', okJson([
                { path: 'a.js', start_line: 3, end_line: 3, annotation_level: 'failure', title: 'x', message: 'm' },
            ])],
            ['/check-runs', okJson({ check_runs: [{ id: 77, name: 'lint', output: { annotations_count: 1 } }] })],
        ]);
        const out = await new PullRequestService({ githubToken: 't' })
            .fetchCheckAnnotations('https://github.com/o/r/pull/5', 'c'.repeat(40));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ path: 'a.js', startLine: 3, checkName: 'lint' });
        expect(global.fetch.mock.calls[0][0]).toContain('/check-runs?per_page=10');
    });
});

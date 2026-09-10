/**
 * P0-4 — an incomplete host diff must never become a clean empty review.
 *
 * The defect: `fetch(.../changes).then(r => r.ok ? r.json() : { changes: [] })`
 * mapped every 401, 429 and 500 to "this MR changes no files". Zero files
 * reviews clean, and clean approves. Pagination caps and provider-truncated
 * diffs had the same shape.
 */
const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { isComplete, completenessReasons } = require('../../src/utils/reviewCompleteness.js');

const MR_URL = 'https://gitlab.com/acme/web/-/merge_requests/7';

const mrBody = {
    id: 1, iid: 7, title: 'change', description: '', state: 'opened',
    author: { username: 'dev' },
    source_branch: 'feat', target_branch: 'main',
    diff_refs: { head_sha: 'head1', base_sha: 'base1' },
    labels: [], created_at: '', updated_at: '', web_url: MR_URL,
};

/** Route a fetch by URL suffix so ordering between parallel calls is irrelevant. */
function routeFetch(routes) {
    return jest.fn(async (url) => {
        for (const [needle, response] of routes) {
            if (String(url).includes(needle)) return response;
        }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => [] };
    });
}

const okJson = (body) => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
});

describe('a failed GitLab diff fetch is a failure, not an empty change list', () => {
    const svc = () => new PullRequestService({ gitlabToken: 't' });

    for (const status of [401, 429, 500]) {
        it(`rejects on HTTP ${status} from /changes instead of reviewing zero files`, async () => {
            global.fetch = routeFetch([
                ['/changes', { ok: false, status, statusText: 'nope', json: async () => ({}) }],
                ['/notes', okJson([])],
                ['/commits', okJson([])],
                ['/approvals', okJson({})],
                ['/merge_requests/7', okJson(mrBody)],
            ]);

            await expect(
                svc().fetchGitLabMR({ projectPath: 'acme/web', mrNumber: 7 }),
            ).rejects.toThrow(/diff fetch failed/i);
        });
    }

    it('a genuinely empty MR is still a complete, reviewable result', async () => {
        global.fetch = routeFetch([
            ['/changes', okJson({ changes: [] })],
            ['/notes', okJson([])],
            ['/commits', okJson([])],
            ['/approvals', okJson({})],
            ['/merge_requests/7', okJson(mrBody)],
        ]);

        const mr = await svc().fetchGitLabMR({ projectPath: 'acme/web', mrNumber: 7 });
        expect(mr.files).toEqual([]);
        expect(isComplete(mr.completeness)).toBe(true);
    });

    it('records GitLab\'s own diff-overflow truncation as an omission', async () => {
        global.fetch = routeFetch([
            ['/changes', okJson({
                overflow: true,
                changes: [{ new_path: 'a.js', old_path: 'a.js', diff: '@@ -1 +1,2 @@\n a\n+b' }],
            })],
            ['/notes', okJson([])],
            ['/commits', okJson([])],
            ['/approvals', okJson({})],
            ['/merge_requests/7', okJson(mrBody)],
        ]);

        const mr = await svc().fetchGitLabMR({ projectPath: 'acme/web', mrNumber: 7 });
        expect(isComplete(mr.completeness)).toBe(false);
        expect(completenessReasons(mr.completeness).join(' ')).toMatch(/provider-truncated/);
    });

    it('records a file the provider listed but sent no diff for', async () => {
        global.fetch = routeFetch([
            ['/changes', okJson({ changes: [{ new_path: 'big.bin', old_path: 'big.bin', diff: '' }] })],
            ['/notes', okJson([])],
            ['/commits', okJson([])],
            ['/approvals', okJson({})],
            ['/merge_requests/7', okJson(mrBody)],
        ]);

        const mr = await svc().fetchGitLabMR({ projectPath: 'acme/web', mrNumber: 7 });
        expect(completenessReasons(mr.completeness).join(' ')).toMatch(/missing-patch|binary/);
    });
});

describe('pagination stops are recorded, not silently accepted', () => {
    it('a mid-pagination HTTP error is an omission rather than a shorter list', async () => {
        const svc = new PullRequestService({ gitlabToken: 't' });
        svc._beginFetch();
        global.fetch = jest.fn(async () => ({
            ok: false, status: 502, statusText: 'Bad Gateway',
            headers: { get: () => null }, json: async () => [],
        }));

        const out = await svc.fetchAllPagesGitLab('https://api/x/commits', {});
        expect(out).toEqual([]);
        expect(completenessReasons(svc._buildFetchCompleteness()).join(' '))
            .toMatch(/page-fetch-failed/);
    });

    it('exhausting the page cap is recorded as an omission', async () => {
        const svc = new PullRequestService({ githubToken: 't' });
        svc._beginFetch();
        // Always a full page plus a next link: pagination can never finish.
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200, statusText: 'OK',
            headers: { get: (h) => (h === 'Link' ? '<https://api/x?page=99>; rel="next"' : null) },
            json: async () => Array.from({ length: 100 }, (_, i) => ({ i })),
        }));

        await svc.fetchAllPagesGitHub('https://api/x/files', {}, 2);
        expect(completenessReasons(svc._buildFetchCompleteness()).join(' '))
            .toMatch(/pagination-cap/);
    });

    it('a normal complete pagination records nothing', async () => {
        const svc = new PullRequestService({ githubToken: 't' });
        svc._beginFetch();
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200, statusText: 'OK',
            headers: { get: () => null },
            json: async () => [{ filename: 'a.js', patch: '@@' }],
        }));

        await svc.fetchAllPagesGitHub('https://api/x/files', {});
        expect(isComplete(svc._buildFetchCompleteness())).toBe(true);
    });
});

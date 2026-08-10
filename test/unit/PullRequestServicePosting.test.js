/**
 * Tests for the PR-posting paths.
 *
 * Covers three shipped defects:
 *   - `formatInlineComments` dropped every LLM finding (required `filePath`).
 *   - GitHub's Reviews API is atomic: one out-of-diff line 422'd the ENTIRE
 *     review, summary included, and nothing was retried.
 *   - GitLab diff notes read base/start/head SHA off each comment object, which
 *     never carried them — so `position` was all-undefined and every inline
 *     note was silently rejected.
 */

const { PullRequestService } = require('../../src/services/PullRequestService.js');

const PATCH = [
    '@@ -1,3 +1,6 @@',
    ' const a = 1;',
    '+const b = getB();',
    '+eval(input);',
    ' module.exports = { a };',
].join('\n');
// new-side: 1 context, 2-3 added, 4 context

const prData = { files: [{ filename: 'src/a.js', patch: PATCH }] };

const jsonResponse = (body, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    statusText: ok ? 'OK' : 'Error',
});

describe('formatInlineComments delegation', () => {
    const svc = new PullRequestService();

    it('formats LLM findings that only carry `file`', () => {
        const out = svc.formatInlineComments(
            [{ severity: 'high', title: 'eval', file: 'src/a.js', line: 3 }],
            { prData }
        );
        expect(out).toHaveLength(1);
        expect(out[0].path).toBe('src/a.js');
    });

    it('validates against the diff when prData is supplied', () => {
        const out = svc.formatInlineComments(
            [{ severity: 'high', title: 'far', file: 'src/a.js', line: 999 }],
            { prData }
        );
        expect(out).toHaveLength(0);
    });

    it('does not recurse into itself', () => {
        // The method and the imported helper share a name; a bare call inside the
        // method must resolve to the import, not `this`.
        expect(() => svc.formatInlineComments([], {})).not.toThrow();
    });
});

describe('postGitHubReview', () => {
    let svc;
    beforeEach(() => {
        svc = new PullRequestService({ githubToken: 'tok' });
        global.fetch = jest.fn();
    });
    afterEach(() => { delete global.fetch; });

    const prInfo = { owner: 'o', repo: 'r', prNumber: 7 };
    const comments = [{ path: 'src/a.js', line: 3, body: 'bad' }];

    it('posts summary and comments in one atomic review on the happy path', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse({ id: 1, html_url: 'u' }));

        const res = await svc.postGitHubReview(prInfo, { summary: 's', inlineComments: comments, event: 'COMMENT' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(res.commentsPosted).toBe(1);
        expect(res.degraded).toBe(false);

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.comments[0]).toMatchObject({ path: 'src/a.js', line: 3, side: 'RIGHT' });
    });

    it('falls back to summary + per-comment posting when the batch 422s', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ message: 'line must be part of the diff' }, false, 422)) // batch
            .mockResolvedValueOnce(jsonResponse({ id: 1, html_url: 'u' }))   // summary-only review
            .mockResolvedValueOnce(jsonResponse({ head: { sha: 'abc' } }))   // head sha lookup
            .mockResolvedValueOnce(jsonResponse({ id: 99 }));                // standalone comment

        const res = await svc.postGitHubReview(prInfo, { summary: 's', inlineComments: comments });

        // The summary survived — previously the whole review was lost.
        expect(res.hasSummary).toBe(true);
        expect(res.degraded).toBe(true);
        expect(res.commentsPosted).toBe(1);
    });

    it('keeps the good comments when only some are rejected in the fallback', async () => {
        const two = [
            { path: 'src/a.js', line: 3, body: 'ok' },
            { path: 'src/a.js', line: 999, body: 'bad' },
        ];
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ message: 'bad line' }, false, 422))
            .mockResolvedValueOnce(jsonResponse({ id: 1, html_url: 'u' }))
            .mockResolvedValueOnce(jsonResponse({ head: { sha: 'abc' } }))
            .mockResolvedValueOnce(jsonResponse({ id: 99 }))                       // first ok
            .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, false, 422)); // second rejected

        const res = await svc.postGitHubReview(prInfo, { summary: 's', inlineComments: two });
        expect(res.commentsPosted).toBe(1);
        expect(res.commentsAttempted).toBe(2);
    });

    it('rethrows non-422 errors instead of silently degrading', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, false, 401));
        await expect(
            svc.postGitHubReview(prInfo, { summary: 's', inlineComments: comments })
        ).rejects.toThrow(/401/);
    });

    it('requires a token', async () => {
        const noTok = new PullRequestService();
        await expect(noTok.postGitHubReview(prInfo, {})).rejects.toThrow(/token is required/i);
    });
});

describe('postGitLabReview', () => {
    let svc;
    beforeEach(() => {
        svc = new PullRequestService({ gitlabToken: 'tok' });
        global.fetch = jest.fn();
    });
    afterEach(() => { delete global.fetch; });

    const prInfo = { owner: 'g', repo: 'p', mrNumber: 5, projectPath: 'g/p' };
    const comments = [{ path: 'src/a.js', line: 3, body: 'bad' }];

    it('positions diff notes with the MR diff_refs', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))  // summary note
            .mockResolvedValueOnce(jsonResponse({            // MR fetch for diff_refs
                diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
            }))
            .mockResolvedValueOnce(jsonResponse({ id: 20 })); // discussion

        const res = await svc.postGitLabReview(prInfo, { summary: 'sum', inlineComments: comments });

        expect(res.commentsPosted).toBe(1);
        const discussionBody = JSON.parse(global.fetch.mock.calls[2][1].body);
        // Previously these were all undefined and GitLab rejected the note.
        expect(discussionBody.position).toMatchObject({
            base_sha: 'b', start_sha: 's', head_sha: 'h',
            new_path: 'src/a.js', new_line: 3, position_type: 'text',
        });
    });

    it('omits old_line for a note on an ADDED line', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))
            .mockResolvedValueOnce(jsonResponse({ id: 20 }));

        await svc.postGitLabReview(prInfo, {
            summary: 'sum',
            inlineComments: [{ path: 'src/a.js', line: 3, body: 'bad' }],
            diffRefs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
        });

        const position = JSON.parse(global.fetch.mock.calls[1][1].body).position;
        expect(position.new_line).toBe(3);
        // GitLab 400s an added-line note that also carries old_line.
        expect(position).not.toHaveProperty('old_line');
    });

    it('sends old_line for a note on an UNCHANGED (context) line', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))
            .mockResolvedValueOnce(jsonResponse({ id: 20 }));

        await svc.postGitLabReview(prInfo, {
            summary: 'sum',
            // new line 4 is ' module.exports = { a };' — unchanged, old side 2.
            inlineComments: [{ path: 'src/a.js', line: 4, oldLine: 2, body: 'ctx' }],
            diffRefs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
        });

        const position = JSON.parse(global.fetch.mock.calls[1][1].body).position;
        expect(position).toMatchObject({ new_line: 4, old_line: 2 });
    });

    it('formatInlineComments resolves oldLine so context notes are postable', () => {
        const fresh = new PullRequestService({ gitlabToken: 'tok' });

        const [added] = fresh.formatInlineComments(
            [{ severity: 'high', title: 'eval', file: 'src/a.js', line: 3 }],
            { prData }
        );
        expect(added.oldLine).toBeUndefined();

        const [context] = fresh.formatInlineComments(
            [{ severity: 'high', title: 'exports', file: 'src/a.js', line: 4 }],
            { prData }
        );
        expect(context.line).toBe(4);
        expect(context.oldLine).toBe(2);
    });

    it('uses caller-supplied diffRefs without a second fetch', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))
            .mockResolvedValueOnce(jsonResponse({ id: 20 }));

        await svc.postGitLabReview(prInfo, {
            summary: 'sum',
            inlineComments: comments,
            diffRefs: { base_sha: 'B', start_sha: 'S', head_sha: 'H' },
        });

        expect(global.fetch).toHaveBeenCalledTimes(2); // no MR lookup
    });

    it('still posts the summary when diff_refs cannot be resolved', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))
            .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, false, 404));

        const res = await svc.postGitLabReview(prInfo, { summary: 'sum', inlineComments: comments });

        expect(res.hasSummary).toBe(true);
        expect(res.commentsPosted).toBe(0);
        expect(res.degraded).toBe(true);
    });

    it('one rejected note does not stop the others', async () => {
        const two = [
            { path: 'src/a.js', line: 3, body: 'a' },
            { path: 'src/a.js', line: 4, body: 'b' },
        ];
        global.fetch
            .mockResolvedValueOnce(jsonResponse({ id: 10 }))
            .mockResolvedValueOnce(jsonResponse({ diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } }))
            .mockResolvedValueOnce(jsonResponse({ message: 'bad position' }, false, 400))
            .mockResolvedValueOnce(jsonResponse({ id: 21 }));

        const res = await svc.postGitLabReview(prInfo, { summary: 's', inlineComments: two });
        expect(res.commentsPosted).toBe(1);
        expect(res.commentsAttempted).toBe(2);
    });
});

describe('head SHA normalization', () => {
    const svc = new PullRequestService();

    it('captures the GitHub head SHA for incremental review', () => {
        const out = svc.normalizeGitHubPR(
            { id: 1, number: 2, head: { ref: 'f', sha: 'HEADSHA' }, base: { ref: 'main', sha: 'BASESHA' }, user: {}, labels: [] },
            [], [], [], []
        );
        expect(out.headSha).toBe('HEADSHA');
        expect(out.baseSha).toBe('BASESHA');
    });
});

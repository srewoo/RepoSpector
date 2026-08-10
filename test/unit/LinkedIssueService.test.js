const {
    LinkedIssueService,
    extractClosingRefs,
    normalizeGitHubIssue,
    normalizeGitLabIssue,
    normalizeJiraIssue,
    flattenADF,
} = require('../../src/services/LinkedIssueService.js');

const { buildIntentBlock } = require('../../src/utils/reviewIntentContext.js');

/** Minimal fetch double: route by URL substring. */
function fakeFetch(routes) {
    return jest.fn(async (url) => {
        for (const [needle, response] of Object.entries(routes)) {
            if (String(url).includes(needle)) {
                return {
                    ok: response.ok !== false,
                    json: async () => response.body,
                };
            }
        }
        return { ok: false, json: async () => ({}) };
    });
}

describe('extractClosingRefs', () => {
    it('finds a closing keyword reference in the body', () => {
        expect(extractClosingRefs({ description: 'Closes #42' }))
            .toEqual([{ owner: null, repo: null, number: 42 }]);
    });

    it('accepts every documented keyword and tense', () => {
        for (const kw of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
            expect(extractClosingRefs({ description: `${kw} #7` })).toHaveLength(1);
        }
    });

    it('accepts a cross-repo reference', () => {
        expect(extractClosingRefs({ description: 'Fixes acme/widgets#9' }))
            .toEqual([{ owner: 'acme', repo: 'widgets', number: 9 }]);
    });

    it('reads the title as well as the body', () => {
        expect(extractClosingRefs({ title: 'Retry uploads (fixes #3)' }))
            .toEqual([{ owner: null, repo: null, number: 3 }]);
    });

    it('ignores a bare issue mention with no closing keyword', () => {
        // A PR that merely references #42 is not implementing it, and treating
        // it as the spec would fabricate criteria for the reviewer to check.
        expect(extractClosingRefs({ description: 'Related to #42, see also #43' }))
            .toEqual([]);
    });

    it('de-duplicates repeated references', () => {
        expect(extractClosingRefs({ title: 'Fixes #5', description: 'Fixes #5 properly' }))
            .toHaveLength(1);
    });

    it('caps how many tickets one PR can drag in', () => {
        const body = 'Closes #1, closes #2, closes #3, closes #4, closes #5';
        expect(extractClosingRefs({ description: body })).toHaveLength(3);
    });

    it('returns empty for absent input rather than throwing', () => {
        expect(extractClosingRefs({})).toEqual([]);
        expect(extractClosingRefs(null)).toEqual([]);
    });
});

describe('normalizeGitHubIssue', () => {
    it('maps the fields buildIntentBlock reads', () => {
        const out = normalizeGitHubIssue({
            number: 42,
            title: 'Retry transient upload failures',
            body: 'Acceptance Criteria:\n- retries 3 times\n- backs off exponentially',
            state: 'open',
            labels: [{ name: 'bug' }, { name: 'P1' }],
            html_url: 'https://github.com/a/b/issues/42',
        });
        expect(out.key).toBe('#42');
        expect(out.summary).toBe('Retry transient upload failures');
        expect(out.type).toBe('bug');
        expect(out.priority).toBe('P1');
        expect(out.status).toBe('open');
    });

    it('tolerates string labels and missing optional fields', () => {
        const out = normalizeGitHubIssue({ number: 1, labels: ['feature'] });
        expect(out.type).toBe('feature');
        expect(out.priority).toBeNull();
        expect(out.summary).toBe('');
    });

    it('rejects a payload that is not an issue', () => {
        expect(normalizeGitHubIssue(null)).toBeNull();
        expect(normalizeGitHubIssue({})).toBeNull();
    });
});

describe('normalizeGitLabIssue', () => {
    it('prefers GitLab\'s own issue_type over label guessing', () => {
        const out = normalizeGitLabIssue({
            iid: 8,
            title: 'Add retry',
            description: 'body',
            issue_type: 'incident',
            labels: ['bug'],
            state: 'opened',
        });
        expect(out.key).toBe('#8');
        expect(out.type).toBe('incident');
    });

    it('rejects a payload that is not an issue', () => {
        expect(normalizeGitLabIssue({})).toBeNull();
    });
});

describe('LinkedIssueService.fetchForPR — GitHub', () => {
    const prInfo = { platform: 'github', owner: 'acme', repo: 'widgets' };

    it('fetches the issue named by a closing keyword', async () => {
        const fetchImpl = fakeFetch({
            '/issues/42': {
                body: {
                    number: 42,
                    title: 'Retry uploads',
                    body: 'Acceptance Criteria:\n- retries 3 times',
                    state: 'open',
                    labels: [],
                },
            },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        const issue = await svc.fetchForPR({ description: 'Closes #42' }, prInfo);
        expect(issue.key).toBe('#42');
        expect(issue.summary).toBe('Retry uploads');
    });

    it('skips a reference that resolves to a pull request, not an issue', async () => {
        // /issues/{n} also serves PRs; presenting another PR as this change's
        // specification would be worse than having no ticket at all.
        const fetchImpl = fakeFetch({
            '/issues/12': { body: { number: 12, title: 'Other PR', pull_request: { url: 'x' } } },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        expect(await svc.fetchForPR({ description: 'Closes #12' }, prInfo)).toBeNull();
    });

    it('falls through to the next reference when one 404s', async () => {
        const fetchImpl = fakeFetch({
            '/issues/1': { ok: false, body: {} },
            '/issues/2': { body: { number: 2, title: 'Real issue', state: 'open', labels: [] } },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        const issue = await svc.fetchForPR({ description: 'Closes #1, closes #2' }, prInfo);
        expect(issue.key).toBe('#2');
    });

    it('makes no request when the PR references nothing', async () => {
        const fetchImpl = fakeFetch({});
        const svc = new LinkedIssueService({ fetchImpl });
        expect(await svc.fetchForPR({ description: 'no refs here' }, prInfo)).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('uses the cross-repo owner when the reference names one', async () => {
        const fetchImpl = fakeFetch({
            'other/proj/issues/9': { body: { number: 9, title: 'Cross', state: 'open', labels: [] } },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        const issue = await svc.fetchForPR({ description: 'Fixes other/proj#9' }, prInfo);
        expect(issue.key).toBe('#9');
    });

    it('returns null rather than throwing when the network fails', async () => {
        const fetchImpl = jest.fn(async () => { throw new Error('offline'); });
        const svc = new LinkedIssueService({ fetchImpl });
        expect(await svc.fetchForPR({ description: 'Closes #1' }, prInfo)).toBeNull();
    });
});

describe('LinkedIssueService.fetchForPR — GitLab', () => {
    const prInfo = { platform: 'gitlab', projectPath: 'group/proj', mrNumber: 7 };

    it('uses the authoritative closes_issues endpoint, not body parsing', async () => {
        const fetchImpl = fakeFetch({
            'merge_requests/7/closes_issues': {
                body: [{ iid: 31, title: 'Add retry', description: 'd', state: 'opened', labels: [] }],
            },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        // Body mentions nothing — GitLab resolves the linkage server-side.
        const issue = await svc.fetchForPR({ description: '' }, prInfo);
        expect(issue.key).toBe('#31');
    });

    it('returns null on an empty list', async () => {
        const fetchImpl = fakeFetch({ 'closes_issues': { body: [] } });
        const svc = new LinkedIssueService({ fetchImpl });
        expect(await svc.fetchForPR({}, prInfo)).toBeNull();
    });
});

describe('the end the whole feature exists for', () => {
    it('turns a fetched issue into acceptance criteria in the review prompt', async () => {
        const fetchImpl = fakeFetch({
            '/issues/42': {
                body: {
                    number: 42,
                    title: 'Retry transient upload failures',
                    body: 'Acceptance Criteria:\n- retries at most 3 times\n- backs off exponentially',
                    state: 'open',
                    labels: [],
                },
            },
        });
        const svc = new LinkedIssueService({ fetchImpl });
        const prData = { title: 'Add retry', description: 'Closes #42' };
        const issue = await svc.fetchForPR(prData, { platform: 'github', owner: 'a', repo: 'b' });

        const block = buildIntentBlock(prData, { issue });

        expect(block).toContain('#42');
        expect(block).toContain('Acceptance criteria');
        expect(block).toContain('1. retries at most 3 times');
        expect(block).toContain('2. backs off exponentially');
        // The instruction that makes an unmet criterion a finding.
        expect(block).toContain('that is a finding');
    });

    it('omits the criteria section entirely when no issue resolves', () => {
        const block = buildIntentBlock(
            { title: 'Add retry', description: 'no ticket' },
            { issue: null },
        );
        expect(block).not.toContain('Acceptance criteria');
    });
});


describe('flattenADF', () => {
    it('keeps bullets as bullets so acceptance criteria still parse', () => {
        // Jira v3 returns ADF, not text. Flattened without structure the
        // criteria arrive as one paragraph and parse as nothing — which is the
        // whole feature failing silently.
        const adf = {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance Criteria' }] },
                {
                    type: 'bulletList',
                    content: [
                        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'retries 3 times' }] }] },
                        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'backs off' }] }] },
                    ],
                },
            ],
        };
        const text = flattenADF(adf);
        expect(text).toContain('## Acceptance Criteria');
        expect(text).toContain('- retries 3 times');
        expect(text).toContain('- backs off');
    });

    it('renders task items as checkboxes', () => {
        const adf = { type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'done thing' }] };
        expect(flattenADF(adf)).toBe('- [x] done thing\n');
    });

    it('recurses through unknown node types rather than dropping their text', () => {
        const adf = { type: 'someFutureNode', content: [{ type: 'text', text: 'still here' }] };
        expect(flattenADF(adf)).toBe('still here');
    });

    it('tolerates absent or malformed input', () => {
        expect(flattenADF(null)).toBe('');
        expect(flattenADF(undefined)).toBe('');
        expect(flattenADF('already text')).toBe('already text');
    });
});

describe('normalizeJiraIssue', () => {
    it('maps v3 fields, flattening the ADF description', () => {
        const out = normalizeJiraIssue({
            key: 'PROJ-123',
            fields: {
                summary: 'Retry uploads',
                description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
                issuetype: { name: 'Bug' },
                priority: { name: 'High' },
                status: { name: 'In Progress' },
            },
        });
        expect(out.key).toBe('PROJ-123');
        expect(out.description.trim()).toBe('body');
        expect(out.type).toBe('Bug');
        expect(out.priority).toBe('High');
        expect(out.status).toBe('In Progress');
    });

    it('accepts a v2 string description unchanged', () => {
        const out = normalizeJiraIssue({ key: 'P-1', fields: { description: 'plain text' } });
        expect(out.description).toBe('plain text');
    });

    it('rejects a payload with no key', () => {
        expect(normalizeJiraIssue({ fields: {} })).toBeNull();
    });
});

describe('Jira lookup', () => {
    const creds = {
        jiraBaseUrl: 'https://team.atlassian.net/',
        jiraEmail: 'me@team.com',
        jiraToken: 'tok',
    };

    it('is inert until all three credentials are set', () => {
        expect(new LinkedIssueService({}).jiraConfigured).toBe(false);
        expect(new LinkedIssueService({ jiraBaseUrl: 'x', jiraEmail: 'y' }).jiraConfigured).toBe(false);
        expect(new LinkedIssueService(creds).jiraConfigured).toBe(true);
    });

    it('authenticates with Basic auth and strips the trailing slash from the base URL', async () => {
        let seen = null;
        const svc = new LinkedIssueService({
            ...creds,
            fetchImpl: async (url, init) => {
                seen = { url, init };
                return { ok: true, json: async () => ({ key: 'PROJ-1', fields: { summary: 's' } }) };
            },
        });
        const issue = await svc.fetchJiraIssue('PROJ-1');

        expect(seen.url).toContain('https://team.atlassian.net/rest/api/3/issue/PROJ-1');
        expect(seen.url).not.toContain('.net//rest');
        expect(seen.init.headers.Authorization).toBe(`Basic ${btoa('me@team.com:tok')}`);
        expect(issue.url).toBe('https://team.atlassian.net/browse/PROJ-1');
    });

    it('returns null on a 404 rather than failing the review', async () => {
        const svc = new LinkedIssueService({ ...creds, fetchImpl: async () => ({ ok: false, status: 404 }) });
        expect(await svc.fetchJiraIssue('NOPE-1')).toBeNull();
    });

    it('returns null when the network fails', async () => {
        const svc = new LinkedIssueService({
            ...creds,
            fetchImpl: async () => { throw new Error('offline'); },
        });
        expect(await svc.fetchJiraIssue('PROJ-1')).toBeNull();
    });

    it('finds the Jira key in a PR title and prefers it over a GitHub issue', async () => {
        // A team running Jira puts the requirement there, so when both exist the
        // Jira ticket is the one carrying acceptance criteria.
        const svc = new LinkedIssueService({
            ...creds,
            fetchImpl: async (url) => {
                if (String(url).includes('/rest/api/3/issue/PROJ-77')) {
                    return { ok: true, json: async () => ({ key: 'PROJ-77', fields: { summary: 'from jira' } }) };
                }
                return { ok: true, json: async () => ({ number: 5, title: 'from github', labels: [] }) };
            },
        });
        const issue = await svc.fetchForPR(
            { title: 'PROJ-77 add retry', description: 'Closes #5' },
            { platform: 'github', owner: 'a', repo: 'b' },
        );
        expect(issue.key).toBe('PROJ-77');
        expect(issue.summary).toBe('from jira');
    });

    it('falls back to the host issue when the Jira key does not resolve', async () => {
        const svc = new LinkedIssueService({
            ...creds,
            fetchImpl: async (url) => {
                if (String(url).includes('/rest/api/3/')) return { ok: false, status: 404 };
                return { ok: true, json: async () => ({ number: 5, title: 'from github', labels: [] }) };
            },
        });
        const issue = await svc.fetchForPR(
            { title: 'PROJ-77 add retry', description: 'Closes #5' },
            { platform: 'github', owner: 'a', repo: 'b' },
        );
        expect(issue.key).toBe('#5');
    });

    it('makes no Jira request when credentials are absent', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }));
        const svc = new LinkedIssueService({ fetchImpl });
        await svc.fetchForPR({ title: 'PROJ-77 thing', description: '' },
            { platform: 'github', owner: 'a', repo: 'b' });
        for (const call of fetchImpl.mock.calls) {
            expect(String(call[0])).not.toContain('/rest/api/');
        }
    });
});

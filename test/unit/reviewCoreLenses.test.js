/**
 * Context-backed finder lenses (spec §3): registry, `needs` resolution, and
 * not-run reporting. The context port is a plain mock — the lenses must never
 * care whether it is backed by the GitHub/GitLab API or local git.
 */
const {
    NEW_LENSES, LENS_LIMITS, LENS_SWITCHES,
    enabledNewLenses, gatherLensContext, prepareLensContexts, selectTargets,
} = require('../../src/review-core/lenses/index.js');

const lens = (key) => NEW_LENSES.find(l => l.key === key);
const ok = (payload) => ({ status: 'ok', ...payload });
const notRun = (reason) => ({ status: 'not-run', reason });

const PATCH = [
    '@@ -10,4 +10,5 @@',
    ' const a = 1;',
    '-if (!user) return;',
    '+doThing(user);',
    '+log(user);',
    ' const b = 2;',
].join('\n');

const file = (filename, extra = {}) => ({ filename, patch: PATCH, additions: 2, deletions: 1, status: 'modified', ...extra });

function port(overrides = {}) {
    return {
        blame: jest.fn(async () => ok({ ranges: [{ start: 10, end: 12, sha: 'abc1234def', message: 'fix: guard null user\n\nbody', date: '2025-01-02' }] })),
        recentCommits: jest.fn(async () => ok({ commits: [{ sha: 'fff0000aaa', message: 'perf: cache lookups', date: '2025-02-03' }] })),
        priorPrComments: jest.fn(async () => ok({ comments: [{ path: 'src/a.js', prRef: '#41', author: 'rev', body: 'Always null-check user here', line: 11 }] })),
        fileContent: jest.fn(async () => ok({ text: 'const a = 1;\n// keep this sorted\nconst z = 0;\n' + 'x\n'.repeat(20) })),
        ...overrides,
    };
}

describe('NEW_LENSES registry', () => {
    it('has exactly the four contract keys, each with needs', () => {
        expect(NEW_LENSES.map(l => l.key)).toEqual(['history', 'codeComments', 'rulesCompliance', 'priorPrComments']);
        for (const l of NEW_LENSES) {
            expect(l.title).toBeTruthy();
            expect(l.instruction).toMatch(/Hunt ONLY/);
            expect(l.needs.length).toBeGreaterThan(0);
        }
    });

    it('rulesCompliance demands a verbatim quotedRule and drops findings without one', () => {
        const rc = lens('rulesCompliance');
        expect(rc.instruction).toMatch(/"quotedRule"/);
        expect(rc.instruction).toMatch(/VERBATIM/);
        expect(rc.accepts({ quotedRule: 'Never log tokens.' })).toBe(true);
        expect(rc.accepts({ quotedRule: '  ' })).toBe(false);
        expect(rc.accepts({})).toBe(false);
    });

    it('limits match the spec', () => {
        expect(LENS_LIMITS).toMatchObject({ maxFiles: 10, maxContextChars: 4000, commentRadius: 40, recentCommits: 5, priorPrLimit: 5 });
    });

    it('enabledNewLenses honours the per-lens switches', () => {
        expect(enabledNewLenses({}).map(l => l.key)).toHaveLength(4);
        const keys = enabledNewLenses({ [LENS_SWITCHES.history]: false, lensPriorPrComments: false }).map(l => l.key);
        expect(keys).toEqual(['codeComments', 'rulesCompliance']);
    });
});

describe('selectTargets', () => {
    it('keeps code files only, skips deleted, ranks by churn, caps at maxFiles', () => {
        const files = [
            file('README.md'),
            file('src/gone.js', { status: 'removed' }),
            ...Array.from({ length: 12 }, (_, i) => file(`src/f${i}.js`, { additions: i, deletions: 0 })),
        ];
        const t = selectTargets(files, 10);
        expect(t).toHaveLength(10);
        expect(t[0].path).toBe('src/f11.js');
        expect(t.map(x => x.path)).not.toContain('README.md');
        expect(t.map(x => x.path)).not.toContain('src/gone.js');
    });

    it('derives the base-side span and the added new-side lines', () => {
        const [t] = selectTargets([file('src/a.js')]);
        expect(t.oldSpan).toEqual({ start: 10, end: 12 });
        expect(t.newLines).toEqual([11, 12]);
    });

    it('an added file has no base side', () => {
        const [t] = selectTargets([file('src/new.js', { status: 'added' })]);
        expect(t.oldSpan).toBeNull();
    });
});

describe('gatherLensContext', () => {
    const opts = (p, extra = {}) => ({ files: [file('src/a.js')], contextPort: p, baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), ...extra });

    it('history: blame + recent commits for the base side', async () => {
        const p = port();
        const res = await gatherLensContext(lens('history'), opts(p));
        expect(res.status).toBe('ok');
        expect(res.text).toContain('abc1234');
        expect(res.text).toContain('fix: guard null user');
        expect(res.text).not.toContain('body');
        expect(res.text).toContain('perf: cache lookups');
        expect(p.blame).toHaveBeenCalledWith('src/a.js', { ref: 'b'.repeat(40), startLine: 10, endLine: 12 });
        expect(p.recentCommits).toHaveBeenCalledWith('src/a.js', { ref: 'b'.repeat(40), limit: 5 });
    });

    it('history: not-run with the port reason when every lookup is not-run', async () => {
        const p = port({
            blame: jest.fn(async () => notRun('no GitHub token')),
            recentCommits: jest.fn(async () => notRun('no GitHub token')),
        });
        expect(await gatherLensContext(lens('history'), opts(p))).toEqual({ status: 'not-run', reason: 'no GitHub token' });
    });

    it('history: not-run when only added files changed', async () => {
        const res = await gatherLensContext(lens('history'), opts(port(), { files: [file('src/n.js', { status: 'added' })] }));
        expect(res.status).toBe('not-run');
        expect(res.reason).toMatch(/base-side/);
    });

    it('codeComments: comments near the changed lines of the post-change file', async () => {
        const p = port();
        const res = await gatherLensContext(lens('codeComments'), opts(p));
        expect(res.status).toBe('ok');
        expect(res.text).toContain('keep this sorted');
        expect(p.fileContent).toHaveBeenCalledWith('src/a.js', 'h'.repeat(40));
    });

    it('codeComments: not-run when the file cannot be read', async () => {
        const p = port({ fileContent: jest.fn(async () => notRun('HTTP 404')) });
        expect(await gatherLensContext(lens('codeComments'), opts(p))).toEqual({ status: 'not-run', reason: 'HTTP 404' });
    });

    it('rulesCompliance: renders the rules files and needs no context port', async () => {
        const res = await gatherLensContext(lens('rulesCompliance'), {
            files: [file('README.md')],
            rulesFiles: [{ path: 'AGENTS.md', text: 'Never log tokens.' }, { path: 'svc/CLAUDE.md', text: '' }],
        });
        expect(res).toEqual({ status: 'ok', text: '### AGENTS.md\nNever log tokens.' });
    });

    it('rulesCompliance: not-run with no rules files', async () => {
        const res = await gatherLensContext(lens('rulesCompliance'), { files: [file('src/a.js')], rulesFiles: [] });
        expect(res.status).toBe('not-run');
        expect(res.reason).toMatch(/no rules files/);
    });

    it('priorPrComments: renders comments, passing priorPrLimit', async () => {
        const p = port();
        const res = await gatherLensContext(lens('priorPrComments'), opts(p, { limits: { priorPrLimit: 3 } }));
        expect(res.text).toContain('[#41] @rev (L11): Always null-check user here');
        expect(p.priorPrComments).toHaveBeenCalledWith('src/a.js', { limitPrs: 3 });
    });

    it('priorPrComments: no comments anywhere is not-run, not an empty context', async () => {
        const p = port({ priorPrComments: jest.fn(async () => ok({ comments: [] })) });
        const res = await gatherLensContext(lens('priorPrComments'), opts(p));
        expect(res.status).toBe('not-run');
        expect(res.reason).toMatch(/no prior PR review comments/);
    });

    it('a port-backed need with no port is not-run', async () => {
        const res = await gatherLensContext(lens('history'), { files: [file('src/a.js')] });
        expect(res.status).toBe('not-run');
        expect(res.reason).toMatch(/no context source/);
    });

    it('a throwing port is not-run, never a throw', async () => {
        const p = port({ priorPrComments: jest.fn(async () => { throw new Error('boom'); }) });
        const res = await gatherLensContext(lens('priorPrComments'), opts(p));
        expect(res).toEqual({ status: 'not-run', reason: 'priorPr context failed: boom' });
    });

    it('caps the context at maxContextChars', async () => {
        const res = await gatherLensContext(lens('rulesCompliance'), {
            rulesFiles: [{ path: 'AGENTS.md', text: 'r'.repeat(10000) }], limits: { maxContextChars: 500 },
        });
        expect(res.text.length).toBeLessThan(600);
        expect(res.text).toMatch(/truncated at 500 chars/);
    });
});

describe('prepareLensContexts', () => {
    it('passes needless lenses through and splits the rest', async () => {
        const plain = { key: 'security', title: 'S', instruction: 'x' };
        const { runnable, contexts, skipped } = await prepareLensContexts(
            [plain, lens('rulesCompliance'), lens('priorPrComments')],
            { files: [file('src/a.js')], rulesFiles: [{ path: 'AGENTS.md', text: 'Rule.' }] },
        );
        expect(runnable.map(l => l.key)).toEqual(['security', 'rulesCompliance']);
        expect(contexts.get('rulesCompliance')).toContain('Rule.');
        expect(skipped).toEqual([{ lens: 'priorPrComments', status: 'not-run', reason: 'no context source for "priorPr"' }]);
    });
});

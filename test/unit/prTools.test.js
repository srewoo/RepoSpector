/**
 * Tests for the three model-backed PR tools. The properties that matter are all
 * about restraint: docstrings only where the PR touched code that has none, a
 * line question that refuses rather than invents when it cannot see the line,
 * and a prior-findings lookup that annotates but never deletes a finding.
 */

const { DocstringService, parseDocstringResponse } = require('../../src/services/DocstringService.js');
const { LineQuestionService } = require('../../src/services/LineQuestionService.js');
const { PriorFindingService, RECOMMENDATION } = require('../../src/services/PriorFindingService.js');

// ── Shared fixture: one JS file, two functions, one already documented ───────

const FILE_LINES = [
    'const db = require("./db");',                       // 1
    '',                                                   // 2
    '/**',                                                // 3
    ' * Already documented.',                             // 4
    ' */',                                                // 5
    'function documented(a, b) {',                        // 6
    '    const x = a + b;',                               // 7
    '    log(x);',                                        // 8
    '    return x;',                                      // 9
    '}',                                                  // 10
    '',                                                   // 11
    'function undocumented(userId, opts) {',              // 12
    '    if (!userId) throw new Error("no id");',         // 13
    '    const row = db.get(userId);',                    // 14
    '    return row ?? opts.fallback;',                   // 15
    '}',                                                  // 16
    '',                                                   // 17
    'const tiny = () => 1;',                              // 18
];
const FILE = FILE_LINES.join('\n');

const DECLS = [
    { name: 'documented', label: 'Function', startLine: 6, endLine: 10, isExported: false },
    { name: 'undocumented', label: 'Function', startLine: 12, endLine: 16, isExported: true },
    { name: 'tiny', label: 'Function', startLine: 18, endLine: 18, isExported: false },
];

/** A patch touching line 14 (inside `undocumented`). */
const PATCH = [
    '@@ -13,3 +13,3 @@',
    '     if (!userId) throw new Error("no id");',
    '-    const row = db.find(userId);',
    '+    const row = db.get(userId);',
    '     return row ?? opts.fallback;',
].join('\n');

const PR = {
    title: 'Use db.get',
    url: 'https://github.com/a/b/pull/7',
    files: [{ filename: 'src/users.js', language: 'javascript', patch: PATCH, status: 'modified' }],
};

const FILE_CONTEXT = new Map([['src/users.js', { fullContent: FILE, truncated: false }]]);
const DECL_MAP = new Map([['src/users.js', DECLS]]);

describe('DocstringService.findUndocumented', () => {
    const svc = () => new DocstringService({ llmService: null });

    it('picks the touched declaration that has no docstring', () => {
        const found = svc().findUndocumented({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP,
        });
        expect(found.map(f => f.name)).toEqual(['undocumented']);
        expect(found[0].source).toContain('function undocumented');
        expect(found[0].docStyle).toBe('jsdoc');
    });

    it('leaves an existing docstring alone', () => {
        // Rewriting someone's prose starts an argument; filling a gap gets merged.
        const touchesDocumented = {
            ...PR,
            files: [{
                ...PR.files[0],
                patch: '@@ -7,1 +7,1 @@\n-    const x = a - b;\n+    const x = a + b;',
            }],
        };
        const found = svc().findUndocumented({
            prData: touchesDocumented, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP,
        });
        expect(found).toEqual([]);
    });

    it('ignores declarations the PR did not touch', () => {
        const found = svc().findUndocumented({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP,
        });
        expect(found.map(f => f.name)).not.toContain('documented');
    });

    it('skips one-liners', () => {
        const touchesTiny = {
            ...PR,
            files: [{ ...PR.files[0], patch: '@@ -18,1 +18,1 @@\n-const tiny = () => 0;\n+const tiny = () => 1;' }],
        };
        expect(svc().findUndocumented({
            prData: touchesTiny, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP,
        })).toEqual([]);
    });

    it('puts exported declarations first', () => {
        const decls = [
            { name: 'privateOne', startLine: 12, endLine: 16, isExported: false },
            { name: 'publicOne', startLine: 12, endLine: 16, isExported: true },
        ];
        const found = svc().findUndocumented({
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: new Map([['src/users.js', decls]]),
        });
        expect(found[0].name).toBe('publicOne');
    });

    it('refuses a language whose comment syntax it does not know', () => {
        // A docstring in the wrong dialect is worse than none.
        const exotic = { ...PR, files: [{ ...PR.files[0], filename: 'a.zig', language: 'zig' }] };
        expect(svc().findUndocumented({
            prData: exotic,
            fileContext: new Map([['a.zig', { fullContent: FILE }]]),
            declarationsByFile: new Map([['a.zig', DECLS]]),
        })).toEqual([]);
    });

    it('needs file content, not just a diff', () => {
        expect(svc().findUndocumented({
            prData: PR, fileContext: new Map(), declarationsByFile: DECL_MAP,
        })).toEqual([]);
    });

    it('honours the caps', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({
            name: `f${i}`, startLine: 12, endLine: 16, isExported: true,
        }));
        const found = svc().findUndocumented({
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: new Map([['src/users.js', many]]),
            options: { maxPerFile: 3, maxTotal: 3 },
        });
        expect(found).toHaveLength(3);
    });

    it('detects a Python docstring inside the body, not above it', () => {
        const py = [
            'def documented(a):',        // 1
            '    """Does a thing."""',   // 2
            '    return a + 1',          // 3
            '',                          // 4
            'def bare(a):',              // 5
            '    x = a + 1',             // 6
            '    log(x)',                // 7
            '    return x',              // 8
        ].join('\n');

        const prPy = {
            files: [{
                filename: 'a.py',
                language: 'python',
                patch: '@@ -1,8 +1,8 @@\n' + [
                    ' def documented(a):',
                    '     """Does a thing."""',
                    '     return a + 1',
                    ' ',
                    ' def bare(a):',
                    '-    x = a',
                    '+    x = a + 1',
                    '     log(x)',
                    '     return x',
                ].join('\n'),
            }],
        };

        const found = svc().findUndocumented({
            prData: prPy,
            fileContext: new Map([['a.py', { fullContent: py }]]),
            declarationsByFile: new Map([['a.py', [
                { name: 'documented', startLine: 1, endLine: 3 },
                { name: 'bare', startLine: 5, endLine: 8 },
            ]]]),
        });
        expect(found.map(f => f.name)).toEqual(['bare']);
    });

    it('sees past decorators and annotations above a declaration', () => {
        const lines = [
            '/** Documented. */',      // 1
            '@Override',               // 2
            'function decorated(a) {', // 3
            '    const b = a + 1;',    // 4
            '    log(b);',             // 5
            '    return b;',           // 6
            '}',                       // 7
        ].join('\n');

        const found = svc().findUndocumented({
            prData: {
                files: [{
                    filename: 'a.js',
                    language: 'javascript',
                    patch: '@@ -4,1 +4,1 @@\n-    const b = a;\n+    const b = a + 1;',
                }],
            },
            fileContext: new Map([['a.js', { fullContent: lines }]]),
            declarationsByFile: new Map([['a.js', [{ name: 'decorated', startLine: 3, endLine: 7 }]]]),
        });
        expect(found).toEqual([]);
    });
});

describe('DocstringService.generate', () => {
    function llm(response) {
        return {
            calls: [],
            streamChat: async function (messages, opts) {
                this.calls.push({ messages, opts });
                return { content: response, usage: { input: 10, output: 20 } };
            },
        };
    }

    it('places a JS docstring above the declaration', async () => {
        const fake = llm(JSON.stringify({
            docstrings: [{ name: 'undocumented', docstring: '/**\n * Loads a user row.\n */' }],
        }));
        const svc = new DocstringService({ llmService: fake });

        const res = await svc.generate({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP, settings: {},
        });

        expect(res.docstrings).toHaveLength(1);
        expect(res.docstrings[0]).toMatchObject({
            filename: 'src/users.js',
            name: 'undocumented',
            insertAtLine: 12,
            placement: 'above',
        });
        expect(res.stats.documented).toBe(1);
        expect(res.usage).toEqual({ input: 10, output: 20 });
    });

    it('spends the budget as an optional stage', async () => {
        // Documentation must never consume the allowance a review pass needs.
        const fake = llm('{"docstrings":[]}');
        await new DocstringService({ llmService: fake }).generate({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP, settings: {},
        });
        expect(fake.calls[0].opts.budgetStage).toBe('docstrings');
        expect(fake.calls[0].opts.budgetPriority).toBe('optional');
    });

    it('drops a docstring for a declaration it never asked about', async () => {
        // There is no line to insert it above, so placing it would be a guess.
        const fake = llm(JSON.stringify({
            docstrings: [{ name: 'somethingElse', docstring: '/** ... */' }],
        }));
        const res = await new DocstringService({ llmService: fake }).generate({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP, settings: {},
        });
        expect(res.docstrings).toEqual([]);
    });

    it('survives a failing batch', async () => {
        const svc = new DocstringService({
            llmService: { streamChat: async () => { throw new Error('429'); } },
        });
        const res = await svc.generate({
            prData: PR, fileContext: FILE_CONTEXT, declarationsByFile: DECL_MAP, settings: {},
        });
        expect(res.docstrings).toEqual([]);
        expect(res.stats.failedBatches).toBe(1);
    });

    it('makes no call when there is nothing to document', async () => {
        const fake = llm('{}');
        const res = await new DocstringService({ llmService: fake }).generate({
            prData: PR, fileContext: new Map(), settings: {},
        });
        expect(fake.calls).toHaveLength(0);
        expect(res.stats.candidates).toBe(0);
    });
});

describe('parseDocstringResponse', () => {
    it('reads a bare array or a wrapped object', () => {
        expect(parseDocstringResponse('[{"name":"a","docstring":"/** x */"}]')).toHaveLength(1);
        expect(parseDocstringResponse('{"docstrings":[{"name":"a","docstring":"x"}]}')).toHaveLength(1);
    });

    it('tolerates a fenced block', () => {
        expect(parseDocstringResponse('```json\n{"docstrings":[{"name":"a","docstring":"x"}]}\n```'))
            .toHaveLength(1);
    });

    it('returns nothing for junk rather than throwing', () => {
        for (const junk of ['', null, 'not json', '{"docstrings": "nope"}', '{}']) {
            expect(parseDocstringResponse(junk)).toEqual([]);
        }
    });

    it('drops entries missing a name or a docstring', () => {
        expect(parseDocstringResponse('{"docstrings":[{"name":"a"},{"docstring":"x"},{"name":"b","docstring":"y"}]}'))
            .toEqual([{ name: 'b', docstring: 'y' }]);
    });
});

describe('LineQuestionService.parseTarget', () => {
    it('parses file:line', () => {
        expect(LineQuestionService.parseTarget('src/a.js:214')).toEqual({ filename: 'src/a.js', line: 214 });
        expect(LineQuestionService.parseTarget('  src/a.js:1  ')).toEqual({ filename: 'src/a.js', line: 1 });
    });

    it('takes the LAST colon, so a path containing one still parses', () => {
        expect(LineQuestionService.parseTarget('a:b/c.js:9')).toEqual({ filename: 'a:b/c.js', line: 9 });
    });

    it('rejects anything unusable', () => {
        for (const bad of ['', null, 'src/a.js', 'src/a.js:', ':12', 'src/a.js:0', 'src/a.js:abc', 'a.js:-3', 'a.js:1.5']) {
            expect(LineQuestionService.parseTarget(bad)).toBeNull();
        }
    });
});

describe('LineQuestionService.buildContext', () => {
    const svc = () => new LineQuestionService({ llmService: null });

    it('assembles the line, its enclosing function, and the diff', () => {
        const res = svc().buildContext({
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: DECL_MAP,
            target: { filename: 'src/users.js', line: 14 },
        });

        expect(res.ok).toBe(true);
        expect(res.context.lineContent).toBe('    const row = db.get(userId);');
        expect(res.context.scope.name).toBe('undocumented');
        expect(res.context.scope.source).toContain('function undocumented');
        expect(res.context.inDiff).toBe(true);
    });

    it('says when the line is NOT part of the diff', () => {
        // The reader assumes the PR changed it; the answer has to correct that.
        const res = svc().buildContext({
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: DECL_MAP,
            target: { filename: 'src/users.js', line: 8 },
        });
        expect(res.ok).toBe(true);
        expect(res.context.inDiff).toBe(false);
    });

    it('refuses a file the PR does not change', () => {
        const res = svc().buildContext({
            prData: PR, fileContext: FILE_CONTEXT, target: { filename: 'src/other.js', line: 3 },
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/not one of the 1 file/);
    });

    it('accepts a partial path, as pasted from a host UI', () => {
        const res = svc().buildContext({
            prData: PR, fileContext: FILE_CONTEXT, target: { filename: 'users.js', line: 14 },
        });
        expect(res.ok).toBe(true);
    });

    it('refuses a line past the end of the file', () => {
        const res = svc().buildContext({
            prData: PR, fileContext: FILE_CONTEXT, target: { filename: 'src/users.js', line: 9999 },
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/no line 9999/);
    });

    it('falls back to a window when no declaration encloses the line', () => {
        const res = svc().buildContext({
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: DECL_MAP,
            target: { filename: 'src/users.js', line: 1 },
        });
        expect(res.ok).toBe(true);
        expect(res.context.scope.name).toBeNull();
        expect(res.context.scope.startLine).toBe(1);
    });

    it('refuses with no target', () => {
        expect(svc().buildContext({ prData: PR, fileContext: FILE_CONTEXT }).ok).toBe(false);
    });
});

describe('LineQuestionService.ask', () => {
    it('answers a grounded question', async () => {
        const fake = {
            calls: [],
            streamChat: async function (m, o) { this.calls.push(o); return { content: ' Because x. ' }; },
        };
        const res = await new LineQuestionService({ llmService: fake }).ask({
            question: 'Why db.get?',
            rawTarget: 'src/users.js:14',
            prData: PR,
            fileContext: FILE_CONTEXT,
            declarationsByFile: DECL_MAP,
            settings: {},
        });

        expect(res.grounded).toBe(true);
        expect(res.answer).toBe('Because x.');
        expect(res.context.scope).toBe('undocumented');
        expect(fake.calls[0].budgetStage).toBe('line-question');
    });

    it('refuses without calling the model when it cannot see the line', async () => {
        // The alternative is inventing what is on line 14 of a file it never read.
        const fake = { calls: [], streamChat: async function () { this.calls.push(1); return { content: 'x' }; } };
        const res = await new LineQuestionService({ llmService: fake }).ask({
            question: 'Why?',
            rawTarget: 'src/nope.js:14',
            prData: PR,
            fileContext: FILE_CONTEXT,
            settings: {},
        });

        expect(res.grounded).toBe(false);
        expect(fake.calls).toHaveLength(0);
        expect(res.answer).toMatch(/not one of/);
    });

    it('refuses an unparseable target', async () => {
        const res = await new LineQuestionService({ llmService: {} }).ask({
            question: 'Why?', rawTarget: 'src/users.js', prData: PR, fileContext: FILE_CONTEXT,
        });
        expect(res.grounded).toBe(false);
        expect(res.answer).toMatch(/file\.js:214/);
    });
});

describe('PriorFindingService', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    function ledger(rows) {
        return { getLedger: async () => rows };
    }

    const row = (over = {}) => ({
        prUrl: 'https://github.com/a/b/pull/1',
        repoId: 'a/b',
        rule: 'no-broad-catch',
        file: 'src/users.js',
        line: 14,
        weight: -1,
        reasoning: 'Intentional, see ADR-14',
        collectedAt: now - day,
        ...over,
    });

    const finding = (over = {}) => ({
        ruleId: 'no-broad-catch', filePath: 'src/users.js', line: 15, title: 'Broad catch', ...over,
    });

    it('recommends suppressing a rule rejected twice on the same file', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([row(), row({ prUrl: '.../2', line: 20 })]),
        });
        const { findings, stats } = await svc.annotate([finding()], { repoId: 'a/b' });

        expect(findings[0].priorFindings.recommendation).toBe(RECOMMENDATION.SUPPRESS);
        expect(findings[0].priorFindings.rejected).toBe(2);
        expect(stats.suppressRecommended).toBe(1);
    });

    it('keeps a rule that was accepted before', async () => {
        const svc = new PriorFindingService({ feedbackCollector: ledger([row({ weight: 1 })]) });
        const { findings } = await svc.annotate([finding()]);
        expect(findings[0].priorFindings.recommendation).toBe(RECOMMENDATION.KEEP);
    });

    it('does not let a stale verdict decide anything', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([
                row({ collectedAt: now - 200 * day }),
                row({ collectedAt: now - 200 * day, prUrl: '.../2' }),
            ]),
        });
        const { findings } = await svc.annotate([finding()]);
        expect(findings[0].priorFindings.prior[0].stale).toBe(true);
        expect(findings[0].priorFindings.recommendation).toBe(RECOMMENDATION.KEEP);
    });

    it('treats a rejection in a different file as context, not precedent', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([
                row({ file: 'src/other.js' }),
                row({ file: 'src/other.js', prUrl: '.../2' }),
            ]),
        });
        const { findings } = await svc.annotate([finding()]);
        expect(findings[0].priorFindings.recommendation).toBe(RECOMMENDATION.KEEP);
        expect(findings[0].priorFindings.prior).toHaveLength(2);
    });

    it('never matches a finding with no rule id', async () => {
        // A wrong match here recommends suppressing a real defect.
        const svc = new PriorFindingService({ feedbackCollector: ledger([row()]) });
        const { findings } = await svc.annotate([finding({ ruleId: undefined, rule: undefined })]);
        expect(findings[0].priorFindings).toBeUndefined();
    });

    it('annotates without ever removing a finding', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([row(), row({ prUrl: '.../2' })]),
        });
        const input = [finding(), finding({ ruleId: 'other-rule' })];
        const { findings } = await svc.annotate(input);
        expect(findings).toHaveLength(2);
    });

    it('ranks nearest evidence first', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([
                row({ file: 'src/far.js', prUrl: '.../far' }),
                row({ file: 'src/users.js', line: 14, prUrl: '.../near' }),
            ]),
        });
        const { findings } = await svc.annotate([finding()]);
        expect(findings[0].priorFindings.prior[0].prUrl).toBe('.../near');
    });

    it('finds related PRs by file overlap, excluding this one', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: ledger([
                row({ prUrl: 'https://github.com/a/b/pull/7' }), // the PR under review
                row({ prUrl: '.../3', file: 'src/users.js' }),
            ]),
        });
        const related = await svc.relatedPRs(PR, { repoId: 'a/b' });
        expect(related.map(r => r.prUrl)).toEqual(['.../3']);
    });

    it('renders a section only when there is something to say', async () => {
        expect(PriorFindingService.renderSection({})).toBe('');

        const svc = new PriorFindingService({
            feedbackCollector: ledger([row(), row({ prUrl: '.../2' })]),
        });
        const { findings } = await svc.annotate([finding()]);
        const md = PriorFindingService.renderSection({ annotatedFindings: findings, relatedPRs: [] });
        expect(md).toContain('Prior Review History');
        expect(md).toContain('ADR-14');
        expect(md).toContain('settled this one');
    });

    it('degrades to no history when the ledger cannot be read', async () => {
        const svc = new PriorFindingService({
            feedbackCollector: { getLedger: async () => { throw new Error('storage gone'); } },
        });
        const { findings, stats } = await svc.annotate([finding()]);
        expect(findings[0].priorFindings).toBeUndefined();
        expect(stats.ledgerRows).toBe(0);
    });

    it('works with no collector at all', async () => {
        const { findings } = await new PriorFindingService().annotate([finding()]);
        expect(findings[0].priorFindings).toBeUndefined();
    });
});

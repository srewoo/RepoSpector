/**
 * reviewQualityStage — the extension's glue between the review handler and the
 * shared review-core (lenses, rubric scorer, permalinks). Pure: no chrome APIs.
 */
const {
    selectNewLenses,
    lensNotRun,
    collectRulesFiles,
    issueText,
    buildRubricContext,
    runRubricStage,
    fileLengthsFrom,
    attachReviewPermalinks,
} = require('../../src/services/reviewQualityStage.js');
const { NEW_LENSES } = require('../../src/review-core/lenses/index.js');
const { RUBRIC_STATUS } = require('../../src/review-core/rubricScorer.js');

// new side: 10 function, 11 const cmd, 12 exec, 13 return null, 14 }
// old side: 10 function, 11 return run, 12 return null, 13 }
const PATCH = [
    '@@ -10,4 +10,5 @@',
    ' function handler(req) {',
    '-  return run(req.body);',
    '+  const cmd = req.query.cmd;',
    '+  exec(cmd);',
    '   return null;',
    ' }',
].join('\n');
const FILES = [{ filename: 'src/api.js', patch: PATCH }];
const SHA = 'a'.repeat(40);

const llmFinding = (over = {}) => ({
    file: 'src/api.js', line: 12, severity: 'high', source: 'llm',
    title: 'Command injection', description: 'req.query.cmd reaches exec()', evidence: 'exec(cmd);',
    ...over,
});

describe('selectNewLenses', () => {
    it('runs every new lens by default', () => {
        const { lenses, lensReport } = selectNewLenses({}, { multiFinderEnabled: true });
        expect(lenses.map(l => l.key).sort()).toEqual(NEW_LENSES.map(l => l.key).sort());
        expect(lensReport).toEqual([]);
    });

    it('reports a lens switched off by config as not-run, naming the key', () => {
        const { lenses, lensReport } = selectNewLenses({ lensHistory: false }, { multiFinderEnabled: true });
        expect(lenses.map(l => l.key)).not.toContain('history');
        expect(lensReport).toEqual([{ lens: 'history', status: 'not-run', reason: 'lensHistory is false' }]);
    });

    it('reports every new lens as not-run when the multi-finder is off', () => {
        const { lenses, lensReport } = selectNewLenses({}, { multiFinderEnabled: false });
        expect(lenses).toEqual([]);
        expect(lensReport.map(r => r.lens).sort())
            .toEqual(['codeComments', 'history', 'priorPrComments', 'rulesCompliance']);
        expect(lensReport.every(r => r.status === 'not-run' && /multiFinder/.test(r.reason))).toBe(true);
    });
});

describe('lensNotRun', () => {
    it('maps lenses to not-run entries with one reason', () => {
        expect(lensNotRun([{ key: 'history' }], 'boom'))
            .toEqual([{ lens: 'history', status: 'not-run', reason: 'boom' }]);
    });
});

describe('collectRulesFiles', () => {
    it('dedupes instruction files across changed paths and adds .repospector.yaml rules', () => {
        const instructionScopes = {
            byPath: new Map([
                ['src/a.js', [{ path: 'CLAUDE.md', text: 'Use x' }]],
                ['src/b.js', [{ path: 'CLAUDE.md', text: 'Use x' }, { path: 'src/AGENTS.md', text: 'No y' }]],
            ]),
        };
        const out = collectRulesFiles({
            instructionScopes,
            repoInstructions: 'ignored when scopes exist',
            repoRules: [{ pattern: 'console\\.log', message: 'No console.log in src' }],
        });
        expect(out).toEqual([
            { path: 'CLAUDE.md', text: 'Use x' },
            { path: 'src/AGENTS.md', text: 'No y' },
            { path: '.repospector.yaml', text: '- No console.log in src' },
        ]);
    });

    it('falls back to the flat repo instructions when no scopes resolved', () => {
        expect(collectRulesFiles({ instructionScopes: null, repoInstructions: 'Prefer const' }))
            .toEqual([{ path: 'AGENTS.md / CLAUDE.md', text: 'Prefer const' }]);
    });

    it('returns [] when the repo has no rules at all', () => {
        expect(collectRulesFiles({})).toEqual([]);
    });
});

describe('issueText', () => {
    it('renders key, summary and description', () => {
        expect(issueText({ key: '#4', summary: 'Fix login', description: 'Body' })).toBe('#4: Fix login\nBody');
    });
    it('is empty for no issue', () => {
        expect(issueText(null)).toBe('');
    });
});

describe('buildRubricContext', () => {
    it('returns the hunk around the line and the pre-change side', () => {
        const ctx = buildRubricContext(llmFinding(), { files: FILES, rulesFiles: [] });
        expect(ctx.hunk).toContain('+  exec(cmd);');
        expect(ctx.hunk).toContain('-  return run(req.body);');
        expect(ctx.preChangeLines).toContain('return run(req.body);');
        expect(ctx.preChangeLines).not.toContain('exec(cmd)');
        expect(ctx.rulesText).toBe('');
    });

    it('is empty (not a throw) for a line outside every hunk', () => {
        const ctx = buildRubricContext(llmFinding({ line: 500 }), { files: FILES, rulesFiles: [] });
        expect(ctx).toEqual({ hunk: '', preChangeLines: '', rulesText: '' });
    });

    it('attaches rules text, capped at 4000 chars, only for a finding that claims a rule', () => {
        const rulesFiles = [{ path: 'CLAUDE.md', text: 'R'.repeat(9000) }];
        const plain = buildRubricContext(llmFinding(), { files: FILES, rulesFiles });
        expect(plain.rulesText).toBe('');

        const rule = buildRubricContext(llmFinding({ lens: 'rulesCompliance' }), { files: FILES, rulesFiles });
        expect(rule.rulesText.startsWith('# CLAUDE.md')).toBe(true);
        expect(rule.rulesText.length).toBeLessThanOrEqual(4000);
    });
});

describe('runRubricStage', () => {
    it('scores model findings and bypasses deterministic ones', async () => {
        const modelPort = jest.fn(async () => ({
            status: 'ok',
            text: JSON.stringify({ score: 92, preExisting: false, quotedRule: null, reason: 'reachable' }),
        }));
        const staticFinding = { ...llmFinding(), source: 'static', title: 'exec with user input' };
        const out = await runRubricStage([llmFinding(), staticFinding], {
            modelPort, files: FILES, rulesFiles: [],
        });
        expect(out.findings[0].rubric.status).toBe(RUBRIC_STATUS.SCORED);
        expect(out.findings[0].rubric.score).toBe(92);
        expect(out.findings[1].rubric.status).toBe(RUBRIC_STATUS.BYPASSED);
        expect(modelPort).toHaveBeenCalledTimes(1);
    });

    it('never throws: a failing model leaves model findings unscored with a reason', async () => {
        const modelPort = jest.fn(async () => { throw new Error('network down'); });
        const out = await runRubricStage([llmFinding()], { modelPort, files: FILES, rulesFiles: [] });
        expect(out.findings).toHaveLength(1);
        expect(out.findings[0].rubric.status).toBe(RUBRIC_STATUS.UNSCORED);
        expect(String(out.findings[0].rubric.reason || '')).not.toBe('');
    });

    it('emits a progress event', async () => {
        const onProgress = jest.fn();
        const modelPort = async () => ({ status: 'not-run', reason: 'budget' });
        await runRubricStage([llmFinding()], { modelPort, files: FILES, rulesFiles: [], onProgress });
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'rubric' }));
    });
});

describe('fileLengthsFrom', () => {
    it('counts lines from prData full content and lets file context override', () => {
        const prData = { files: [{ filename: 'a.js', fullContent: 'x\ny\nz' }, { filename: 'b.js' }] };
        const fileContext = new Map([['b.js', { fullContent: '1\n2' }], ['a.js', { fullContent: '1' }]]);
        expect(fileLengthsFrom(prData, fileContext)).toEqual({ 'a.js': 1, 'b.js': 2 });
        expect(fileLengthsFrom(prData, null)).toEqual({ 'a.js': 3 });
    });
});

describe('attachReviewPermalinks', () => {
    it('adds a full-SHA GitHub permalink with one line of context', () => {
        const [f] = attachReviewPermalinks([llmFinding()], {
            prUrl: 'https://github.com/acme/api/pull/7',
            headSha: SHA,
            fileLengths: { 'src/api.js': 20 },
        });
        expect(f.permalink).toBe(`https://github.com/acme/api/blob/${SHA}/src/api.js#L11-L13`);
    });

    it('returns the findings unchanged for an unparseable URL or a short SHA', () => {
        const input = [llmFinding()];
        expect(attachReviewPermalinks(input, { prUrl: 'not a url', headSha: SHA, fileLengths: {} })).toBe(input);
        expect(attachReviewPermalinks(input, {
            prUrl: 'https://github.com/acme/api/pull/7', headSha: 'abc123', fileLengths: {},
        })).toBe(input);
    });
});

describe('resolveReviewNumbers — validated numeric settings', () => {
    const { resolveReviewNumbers } = require('../../src/services/reviewQualityStage.js');
    const { DEFAULT_MIN_RUBRIC_SCORE } = require('../../src/review-core/rubricScorer.js');
    const { LENS_LIMITS } = require('../../src/review-core/lenses/index.js');

    it.each([[NaN], [''], ['abc'], [null], [undefined], [Infinity]])('minRubricScore %p -> default', (v) => {
        expect(resolveReviewNumbers({ minRubricScore: v }).minRubricScore).toBe(DEFAULT_MIN_RUBRIC_SCORE);
    });
    it.each([[-5, 0], [150, 100], [60, 60], ['70', 70], [0, 0]])('minRubricScore %p -> %p', (v, want) => {
        expect(resolveReviewNumbers({ minRubricScore: v }).minRubricScore).toBe(want);
    });
    it('call options fill in when the config has no minRubricScore', () => {
        expect(resolveReviewNumbers({}, { minRubricScore: 55 }).minRubricScore).toBe(55);
    });

    it.each([[NaN], [''], ['abc'], [null], [undefined]])('priorPrLimit %p -> default', (v) => {
        expect(resolveReviewNumbers({ priorPrLimit: v }).priorPrLimit).toBe(LENS_LIMITS.priorPrLimit);
    });
    it.each([[-5, 1], [150, 20], [3, 3], ['7', 7]])('priorPrLimit %p -> %p', (v, want) => {
        expect(resolveReviewNumbers({ priorPrLimit: v }).priorPrLimit).toBe(want);
    });
});

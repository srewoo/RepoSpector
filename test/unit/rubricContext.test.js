const {
    createRubricContextFor, claimsRule, RUBRIC_RULES_CHARS,
} = require('../../src/review-core/rubricContext.js');
const { parsePatchHunks } = require('../../src/utils/patchLines.js');

const PATCH = [
    '@@ -1,4 +1,4 @@',
    ' export function total(items) {',
    '-  return items.reduce((a, b) => a + b, 0);',
    '+  return items.reduce((a, b) => a + b);',
    ' }',
    ' export const x = 1;',
].join('\n');

const finding = { file: 'src/total.js', line: 2, title: 'reduce without an initial value' };

describe('createRubricContextFor', () => {
    it('renders the hunk around the finding with +/- markers and the pre-change side', () => {
        const ctxFor = createRubricContextFor({ files: [{ filename: 'src/total.js', patch: PATCH }] });
        const ctx = ctxFor(finding);
        expect(ctx.hunk).toContain('--- src/total.js');
        expect(ctx.hunk).toContain('-  return items.reduce((a, b) => a + b, 0);');
        expect(ctx.hunk).toContain('+  return items.reduce((a, b) => a + b);');
        expect(ctx.preChangeLines).toContain('return items.reduce((a, b) => a + b, 0);');
        expect(ctx.preChangeLines).not.toContain('a + b);\n');
    });

    it('accepts already-parsed files', () => {
        const ctxFor = createRubricContextFor({
            files: [{ newPath: 'src/total.js', hunks: parsePatchHunks(PATCH) }],
        });
        expect(ctxFor(finding).hunk).toContain('+  return items.reduce((a, b) => a + b);');
    });

    it('limits the window to ±20 lines of the finding', () => {
        const body = Array.from({ length: 60 }, (_, i) => ` line ${i + 1}`).join('\n');
        const patch = `@@ -1,60 +1,60 @@\n${body}`;
        const ctx = createRubricContextFor({ files: [{ filename: 'a.js', patch }] })({ file: 'a.js', line: 30 });
        expect(ctx.hunk).toContain(' line 10');
        expect(ctx.hunk).toContain(' line 50');
        expect(ctx.hunk).not.toContain(' line 9\n');
        expect(ctx.hunk).not.toContain(' line 51');
    });

    it('returns empty context for a line outside every hunk window', () => {
        const ctx = createRubricContextFor({ files: [{ filename: 'src/total.js', patch: PATCH }] })({ ...finding, line: 500 });
        expect(ctx).toEqual({ hunk: '', preChangeLines: '', rulesText: '' });
    });

    it('returns empty context for a file the diff does not cover', () => {
        const ctx = createRubricContextFor({ files: [] })(finding);
        expect(ctx).toEqual({ hunk: '', preChangeLines: '', rulesText: '' });
    });

    it('supplies rules text only to findings that claim a rule, capped', () => {
        const rulesFiles = [{ path: 'CLAUDE.md', text: 'R'.repeat(RUBRIC_RULES_CHARS + 500) }];
        const ctxFor = createRubricContextFor({ files: [], rulesFiles });
        expect(ctxFor(finding).rulesText).toBe('');
        const ruled = ctxFor({ ...finding, lens: 'rulesCompliance' }).rulesText;
        expect(ruled.length).toBeLessThanOrEqual(RUBRIC_RULES_CHARS);
        expect(ruled.startsWith('# CLAUDE.md')).toBe(true);
    });
});

describe('claimsRule', () => {
    it('matches the contract definition', () => {
        expect(claimsRule({ lens: 'rulesCompliance' })).toBe(true);
        expect(claimsRule({ citation: { rule: 'no-var' } })).toBe(true);
        expect(claimsRule({ rule: 'no-var', category: 'conventions' })).toBe(true);
        expect(claimsRule({ rule: 'no-var', category: 'bug' })).toBe(false);
        expect(claimsRule({})).toBe(false);
    });
});

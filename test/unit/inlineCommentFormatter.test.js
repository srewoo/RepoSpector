/**
 * Regression tests for the review → post last mile.
 *
 * Every bug covered here was live and invisible: the unit tests on each side of
 * the seam passed while the seam itself dropped 100% of LLM findings. These
 * assert the CONTRACT between producers and the posting layer, which is where
 * the breakage actually lived.
 */

const {
    formatInlineComments,
    buildCommentBody,
    findingPath,
    findingSeverity,
} = require('../../src/utils/inlineCommentFormatter.js');
const { buildCommentableLineMap, commentableLines, snapToCommentableLine } = require('../../src/utils/patchLines.js');

const PATCH = [
    '@@ -1,4 +1,8 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = getB();',
    '+function risky(u) {',
    '+  return eval(u);',
    '+}',
    ' module.exports = { a };',
].join('\n');

const prData = { files: [{ filename: 'src/a.js', patch: PATCH }] };

describe('patchLines', () => {
    it('maps added and context lines on the new side', () => {
        const lines = commentableLines(PATCH);
        // new side: 1 context, 2-5 added, 6 context
        expect([...lines].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('excludes deleted lines from the commentable set', () => {
        // `const b = 2;` is deleted — it has no new-side number at all.
        const lines = commentableLines('@@ -1,2 +1,1 @@\n const a = 1;\n-const b = 2;');
        expect([...lines]).toEqual([1]);
    });

    it('snaps a near-miss line and refuses a far one', () => {
        const allowed = new Set([10, 11, 12]);
        expect(snapToCommentableLine(11, allowed)).toBe(11);
        expect(snapToCommentableLine(13, allowed, 5)).toBe(12);
        expect(snapToCommentableLine(400, allowed, 5)).toBeNull();
    });
});

describe('finding shape normalization', () => {
    it('reads the file path from every producer shape', () => {
        expect(findingPath({ filePath: 'a.js' })).toBe('a.js'); // static analysis
        expect(findingPath({ file: 'b.js' })).toBe('b.js');     // LLM / orchestrator
        expect(findingPath({ path: 'c.js' })).toBe('c.js');
        expect(findingPath({})).toBeNull();
    });

    it('maps canonical severities onto the legacy scale', () => {
        expect(findingSeverity({ severity: 'blocking' })).toBe('high');
        expect(findingSeverity({ severity: 'suggestion' })).toBe('medium');
        expect(findingSeverity({ severity: 'nitpick' })).toBe('low');
        expect(findingSeverity({ severity: 'CRITICAL' })).toBe('critical');
    });
});

describe('formatInlineComments — producer shapes', () => {
    const map = buildCommentableLineMap(prData.files);

    it('posts LLM findings from the per-file container shape', () => {
        // REGRESSION: the multi-pass engine returns per-file containers. The old
        // formatter looked for `filePath`/`line` on the container itself, found
        // neither, and produced zero comments.
        const perFile = [{
            file: 'src/a.js',
            language: 'js',
            findings: [{ severity: 'high', message: 'eval on user input', line: 5 }],
        }];
        const out = formatInlineComments(perFile, { commentableLines: map });
        expect(out).toHaveLength(1);
        expect(out[0].path).toBe('src/a.js');
        expect(out[0].line).toBe(5);
    });

    it('posts LLM findings from the flat orchestrator shape', () => {
        // REGRESSION: the orchestrator adapter emits `file`, not `filePath`.
        const flat = [{ severity: 'blocking', title: 'Null deref', file: 'src/a.js', line: 3 }];
        const out = formatInlineComments(flat, { commentableLines: map });
        expect(out).toHaveLength(1);
        expect(out[0].line).toBe(3);
    });

    it('still posts static-analysis findings', () => {
        const stat = [{ severity: 'high', message: 'no-eval', filePath: 'src/a.js', line: 5, ruleId: 'no-eval' }];
        const out = formatInlineComments(stat, { commentableLines: map });
        expect(out).toHaveLength(1);
    });

    it('produces comments for a mixed batch from all three producers', () => {
        const mixed = [
            { file: 'src/a.js', findings: [{ severity: 'high', message: 'A', line: 2 }] },
            { severity: 'blocking', title: 'B', file: 'src/a.js', line: 3 },
            { severity: 'medium', message: 'C', filePath: 'src/a.js', line: 4 },
        ];
        expect(formatInlineComments(mixed, { commentableLines: map })).toHaveLength(3);
    });
});

describe('formatInlineComments — diff position safety', () => {
    const map = buildCommentableLineMap(prData.files);

    it('drops a finding whose line is outside the diff', () => {
        // GitHub 422s the ENTIRE review for one bad position, so this must not
        // reach the API.
        const out = formatInlineComments(
            [{ severity: 'high', message: 'far', file: 'src/a.js', line: 900 }],
            { commentableLines: map }
        );
        expect(out).toHaveLength(0);
    });

    it('drops findings for files not in the PR', () => {
        const out = formatInlineComments(
            [{ severity: 'high', message: 'other', file: 'src/other.js', line: 2 }],
            { commentableLines: map }
        );
        expect(out).toHaveLength(0);
    });

    it('snaps an off-by-a-few line onto the diff instead of dropping it', () => {
        const out = formatInlineComments(
            [{ severity: 'high', message: 'close', file: 'src/a.js', line: 8 }],
            { commentableLines: map, snapDistance: 5 }
        );
        expect(out).toHaveLength(1);
        expect(out[0].line).toBe(6); // nearest legal line
    });

    it('skips validation entirely when no line map is supplied', () => {
        const out = formatInlineComments(
            [{ severity: 'high', message: 'x', file: 'src/a.js', line: 900 }],
            {}
        );
        expect(out).toHaveLength(1);
    });
});

describe('formatInlineComments — noise control', () => {
    const map = buildCommentableLineMap(prData.files);

    it('merges multiple findings on the same line into one comment', () => {
        const out = formatInlineComments([
            { severity: 'high', title: 'eval is dangerous', file: 'src/a.js', line: 5 },
            { severity: 'medium', message: 'no-eval', filePath: 'src/a.js', line: 5 },
        ], { commentableLines: map });

        expect(out).toHaveLength(1);
        expect(out[0].body).toContain('1 more finding(s) on this line');
    });

    it('collapses exact duplicates without an extras section', () => {
        const out = formatInlineComments([
            { severity: 'high', title: 'eval is dangerous', file: 'src/a.js', line: 5 },
            { severity: 'high', title: 'eval is dangerous', filePath: 'src/a.js', line: 5 },
        ], { commentableLines: map });

        expect(out).toHaveLength(1);
        expect(out[0].body).not.toContain('more finding(s)');
    });

    it('respects the comment cap, keeping the most severe', () => {
        const many = [
            { severity: 'low', message: 'l', file: 'src/a.js', line: 1 },
            { severity: 'critical', message: 'c', file: 'src/a.js', line: 2 },
            { severity: 'medium', message: 'm', file: 'src/a.js', line: 3 },
        ];
        const out = formatInlineComments(many, { commentableLines: map, maxInlineComments: 1 });
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('critical');
    });

    it('excludes low severity by default', () => {
        const out = formatInlineComments(
            [{ severity: 'nitpick', message: 'style', file: 'src/a.js', line: 2 }],
            { commentableLines: map }
        );
        expect(out).toHaveLength(0);
    });
});

describe('buildCommentBody — credibility markers', () => {
    it('links the rule id when the finding carries a rule URL', () => {
        // A rule the reader can look up beats one they have to trust. This is the
        // payload SARIF ingestion exists to deliver.
        const body = buildCommentBody({
            title: 'Tainted input reaches exec()',
            severity: 'high',
            ruleId: 'js/command-injection',
            ruleUrl: 'https://codeql.github.com/help/js-command-injection/',
        });
        expect(body).toContain('[`js/command-injection`](https://codeql.github.com/help/js-command-injection/)');
    });

    it('falls back to a plain rule id with no URL', () => {
        const body = buildCommentBody({ title: 'x', ruleId: 'my-rule' });
        expect(body).toContain('(`my-rule`)');
        expect(body).not.toContain('](');
    });

    it('attributes an external finding to the tool that found it', () => {
        // A CodeQL finding must not read as this tool's opinion — the
        // attribution is most of why it is credible.
        const body = buildCommentBody({
            title: 'Vulnerable dependency',
            source: 'external',
            attribution: 'Reported by Trivy',
        });
        expect(body).toContain('_Reported by Trivy._');
    });

    it('does not attribute RepoSpector\'s own findings to anyone else', () => {
        const body = buildCommentBody({ title: 'x', source: 'static', attribution: 'Reported by X' });
        expect(body).not.toContain('Reported by X');
    });

    it('says when the comment is not on the line the finding named', () => {
        // Moving a comment onto a line nobody chose and staying quiet about it is
        // a small dishonesty that compounds.
        const body = buildCommentBody({
            title: 'Off-by-one',
            line: 11,
            relocated: { from: 13, to: 11, distance: 2 },
        });
        expect(body).toMatch(/reported on line 13/);
        expect(body).toMatch(/moved 2 line\(s\)/);
    });

    it('says nothing about relocation when the finding was not moved', () => {
        const body = buildCommentBody({ title: 'x', line: 11 });
        expect(body).not.toMatch(/moved/);
    });
});

describe('buildCommentBody', () => {
    it('renders rationale, evidence, rule and a suggestion block', () => {
        const body = buildCommentBody({
            severity: 'high',
            title: 'Code injection',
            description: '`u` flows from the request into eval().',
            rule: 'cwe-94',
            evidence: 'return eval(u);',
            suggestedFix: { replacement: '  return JSON.parse(u);', rationale: 'Parse, do not execute.' },
            source: 'llm',
            confidence: 0.9,
        });

        expect(body).toContain('**HIGH**');
        expect(body).toContain('`cwe-94`');
        expect(body).toContain('Code injection');
        expect(body).toContain('flows from the request');
        expect(body).toContain('<summary>Evidence</summary>');
        expect(body).toContain('```suggestion');
        expect(body).toContain('Parse, do not execute.');
        expect(body).toContain('confidence 90%');
    });

    it('preserves indentation inside a suggestion block', () => {
        // A ```suggestion replaces the line verbatim — trimming the indent would
        // commit misindented code the moment someone clicks Apply.
        const body = buildCommentBody({
            severity: 'high',
            message: 'x',
            suggestedFix: { replacement: '\n    return safe(u);\n' },
        });
        expect(body).toContain('\n    return safe(u);\n');
    });

    it('unwraps a model-added code fence rather than nesting fences', () => {
        const body = buildCommentBody({
            severity: 'high',
            message: 'x',
            suggestedFix: '```js\nconst y = 1;\n```',
        });
        expect(body).toContain('```suggestion\nconst y = 1;\n```');
        expect(body).not.toContain('```js');
    });

    it('falls back to prose remediation when there is no patch', () => {
        const body = buildCommentBody({
            severity: 'medium',
            title: 'Missing null check',
            suggestion: 'Guard the return value before dereferencing.',
        });
        expect(body).toContain('**Fix:** Guard the return value');
        expect(body).not.toContain('```suggestion');
    });
});

/**
 * End-to-end seam test: engine output → canonical findings → inline comments.
 *
 * Three shipped bugs lived in this seam while every unit on either side of it
 * passed its own tests:
 *
 *   1. `flattenPerFileFindings` only understood the nested engine shape, so the
 *      orchestrator's flat output produced an EMPTY verified set — the verdict,
 *      the UI list and the post all fell back to static analysis alone.
 *   2. `formatInlineComments` required `filePath`, a key only static findings
 *      carry, so zero LLM findings were ever posted inline.
 *   3. The UI posted the raw pre-verification list, re-introducing the exact
 *      false positives the verification pass had just removed.
 *
 * This walks a finding all the way through and asserts a non-zero count at the
 * end. Any regression in the contract between these modules fails here.
 */

const { buildCanonicalFindings, countBlocking } = require('../../src/utils/findingsFlatten.js');
const { formatInlineComments } = require('../../src/utils/inlineCommentFormatter.js');
const { buildCommentableLineMap } = require('../../src/utils/patchLines.js');

const PATCH = [
    '@@ -10,3 +10,7 @@',
    ' function handler(req, res) {',
    '+  const cmd = req.query.cmd;',
    '+  exec(cmd);',
    '+  const user = db.find(req.query.id);',
    '+  return res.send(user.name);',
    ' }',
].join('\n');

// new-side numbering: 10 context, 11-14 added, 15 context
const prData = { headSha: 'abc123', files: [{ filename: 'src/api.js', patch: PATCH }] };

/** What MultiPassReviewEngine returns: per-file containers. */
const legacyEngineResult = {
    perFileFindings: [{
        file: 'src/api.js',
        language: 'javascript',
        findings: [
            { severity: 'critical', title: 'Command injection', description: 'req.query.cmd reaches exec() unsanitized.', line: 12, rule: 'cwe-78' },
            { severity: 'high', title: 'Unchecked null', description: 'db.find may return undefined.', line: 14 },
        ],
    }],
};

/** What adaptOrchestratorReport returns: a flat list keyed on `file`. */
const orchestratorResult = {
    perFileFindings: [
        { severity: 'high', type: 'security', title: 'Command injection', message: 'exec on user input', file: 'src/api.js', line: 12, source: 'llm' },
        { severity: 'medium', type: 'logic', title: 'Unchecked null', message: 'user may be undefined', file: 'src/api.js', line: 14, source: 'llm' },
    ],
};

const staticFindings = [
    { severity: 'high', message: 'Detected command execution with user input', filePath: 'src/api.js', line: 12, ruleId: 'no-exec-user-input', tool: 'semgrep' },
];

describe('review → post seam', () => {
    const lineMap = buildCommentableLineMap(prData.files);

    describe.each([
        ['legacy multi-pass (nested containers)', legacyEngineResult],
        ['orchestrator (flat findings)', orchestratorResult],
    ])('%s', (_label, engineResult) => {
        it('produces a non-empty canonical finding set including LLM findings', () => {
            const canonical = buildCanonicalFindings(engineResult.perFileFindings, staticFindings);

            const llm = canonical.filter(f => f.source === 'llm');
            const stat = canonical.filter(f => f.source === 'static');

            expect(llm.length).toBe(2);   // <-- was 0 on the orchestrator path
            expect(stat.length).toBe(1);
            // Every canonical finding must expose `.file`, whatever produced it.
            expect(canonical.every(f => f.file === 'src/api.js')).toBe(true);
        });

        it('computes the verdict from the LLM findings, not static alone', () => {
            const canonical = buildCanonicalFindings(engineResult.perFileFindings, staticFindings);
            expect(countBlocking(canonical)).toBeGreaterThan(0);
        });

        it('posts inline comments for the LLM findings', () => {
            const canonical = buildCanonicalFindings(engineResult.perFileFindings, staticFindings);
            const comments = formatInlineComments(canonical, { commentableLines: lineMap });

            expect(comments.length).toBeGreaterThan(0); // <-- was 0 on BOTH paths

            // Both defects landed as comments, on lines that exist in the diff.
            const lines = comments.map(c => c.line).sort();
            expect(lines).toEqual([12, 14]);
            expect(comments.every(c => lineMap.get('src/api.js').has(c.line))).toBe(true);
            expect(comments.every(c => c.path === 'src/api.js')).toBe(true);
        });

        it('merges the overlapping static finding into the LLM comment on line 12', () => {
            const canonical = buildCanonicalFindings(engineResult.perFileFindings, staticFindings);
            const comments = formatInlineComments(canonical, { commentableLines: lineMap });
            const line12 = comments.find(c => c.line === 12);

            expect(line12).toBeDefined();
            // One comment, not two — the LLM finding and the semgrep hit are the
            // same defect and must not be posted twice.
            expect(comments.filter(c => c.line === 12)).toHaveLength(1);
            expect(line12.body).toMatch(/Command injection/i);
        });
    });

    it('posts the VERIFIED set, so removed false positives never reach the PR', () => {
        const canonical = buildCanonicalFindings(orchestratorResult.perFileFindings, staticFindings);

        // Verification drops the "Unchecked null" finding as a false positive.
        const verified = canonical.filter(f => f.title !== 'Unchecked null');
        const comments = formatInlineComments(verified, { commentableLines: lineMap });

        expect(comments.some(c => /Unchecked null/i.test(c.body))).toBe(false);
        expect(comments.length).toBeGreaterThan(0);
    });

    it('carries fix patches from the pipeline through to the posted comment', () => {
        const canonical = buildCanonicalFindings(orchestratorResult.perFileFindings, []);
        const withFix = canonical.map(f => f.line === 12
            ? { ...f, suggestedFix: { replacement: '  execFile(ALLOWED[cmd]);', rationale: 'Avoid a shell.' } }
            : f);

        const comments = formatInlineComments(withFix, { commentableLines: lineMap });
        const line12 = comments.find(c => c.line === 12);

        expect(line12.body).toContain('```suggestion');
        expect(line12.body).toContain('execFile(ALLOWED[cmd]);');
    });

    describe('static findings are merged exactly once', () => {
        // The orchestrator lifts static findings into its report itself, as the
        // standards phase, hunk-filtered. The handler must therefore NOT pass
        // staticResult.findings in again — doing so listed every static finding
        // twice and doubled its weight in the blocking count. This was harmless
        // while the orchestrator was opt-in and became the default path's bug
        // the moment it was switched on.
        const orchestratorReportFindings = [
            ...orchestratorResult.perFileFindings,
            // what the orchestrator's standards phase already merged in
            { severity: 'high', title: 'Detected command execution with user input', file: 'src/api.js', line: 12, source: 'static' },
        ];

        it('double-counts when the caller re-adds them (the bug)', () => {
            const wrong = buildCanonicalFindings(orchestratorReportFindings, staticFindings);
            const execFindings = wrong.filter(f => f.source === 'static');
            expect(execFindings).toHaveLength(2);
            expect(countBlocking(wrong)).toBe(3);
        });

        it('counts each once when the caller defers to the report (the fix)', () => {
            const right = buildCanonicalFindings(orchestratorReportFindings, []);
            expect(right.filter(f => f.source === 'static')).toHaveLength(1);
            expect(countBlocking(right)).toBe(2);
        });
    });

    it('never emits a comment on a line absent from the diff', () => {
        const bogus = [{ severity: 'critical', title: 'Phantom', file: 'src/api.js', line: 500, source: 'llm' }];
        const comments = formatInlineComments(bogus, { commentableLines: lineMap });
        // One bad position 422s the entire GitHub review — it must be filtered here.
        expect(comments).toHaveLength(0);
    });
});

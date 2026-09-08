import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPremiseGate, renderStaticSection } from '../src/tools/staticFindings.js';

/**
 * The static-rule premise gate, on the MCP path.
 *
 * `src/utils/staticRulePremise.js` was written for exactly this class of
 * failure — its own header quotes the adjudication: "every no-dupe-keys /
 * no-unreachable hit pointed at a hunk with no object literal and no dead
 * code". It had one caller, `FindingVerificationService`, which the extension
 * uses and `review_pr` does not. So the bundle shipped mis-mapped findings
 * under a rubric that calls them "facts about the code", and a reader quoted
 * one back as a defect.
 *
 * The gate is fail-open by design: it refutes only rules it has a predicate
 * for. These tests pin that shape, not just the filtering.
 */

const lintWith = (findings) => ({
    success: true,
    files: [{ filePath: 'src/api.ts', findings: [...findings], success: true }],
    findings: [...findings],
    totalFindings: findings.length,
});

const patchFor = (lines) => [{
    filename: 'src/api.ts',
    patch: ['@@ -1,3 +1,6 @@', ...lines].join('\n'),
}];

test('refutes no-unreachable where nothing above the line terminates', async () => {
    // The live false positive: a CONDITIONAL throw. Code after it is reachable.
    const diffFiles = patchFor([
        '+  const body = IssueRequestSchema.safeParse(req.body);',
        '+  if (!body.success) throw new BadRequestException(body.error.message);',
        '+  const { baseUrl } = getJiraContext();',
    ]);
    const lint = lintWith([{ ruleId: 'no-unreachable', line: 2, filePath: 'src/api.ts' }]);

    const { lint: gated, refuted } = applyPremiseGate(lint, diffFiles);

    assert.equal(gated.findings.length, 0);
    assert.equal(gated.files[0].findings.length, 0);
    assert.equal(refuted.length, 1);
    assert.equal(refuted[0].ruleId, 'no-unreachable');
    assert.match(refuted[0].reason, /mis-mapped/);
});

test('refutes no-dupe-keys where the keys are distinct', async () => {
    const diffFiles = patchFor([
        '+const ReviewRequestSchema = z.object({',
        '+  issueKey: z.string().min(1),',
        '+  testCases: z.array(z.unknown()),',
        '+  existingCaseIds: z.array(z.string()).optional(),',
        '+});',
    ]);
    const lint = lintWith([{ ruleId: 'no-dupe-keys', line: 3, filePath: 'src/api.ts' }]);

    const { lint: gated, refuted } = applyPremiseGate(lint, diffFiles);

    assert.equal(gated.findings.length, 0);
    assert.equal(refuted.length, 1);
});

test('keeps a finding whose premise actually holds', async () => {
    const diffFiles = patchFor([
        '+const o = {',
        '+  host: "a",',
        '+  host: "b",',
        '+};',
    ]);
    const lint = lintWith([{ ruleId: 'no-dupe-keys', line: 3, filePath: 'src/api.ts' }]);

    const { lint: gated, refuted } = applyPremiseGate(lint, diffFiles);

    assert.equal(gated.findings.length, 1);
    assert.equal(refuted.length, 0);
});

test('keeps a rule the gate has no predicate for', async () => {
    const diffFiles = patchFor(['+const a = 1;']);
    const lint = lintWith([{ ruleId: 'some-future-rule', line: 1, filePath: 'src/api.ts' }]);

    const { lint: gated } = applyPremiseGate(lint, diffFiles);

    assert.equal(gated.findings.length, 1);
});

test('keeps a finding for a file the diff carries no patch for', async () => {
    const lint = lintWith([{ ruleId: 'no-dupe-keys', line: 3, filePath: 'src/api.ts' }]);

    const { lint: gated } = applyPremiseGate(lint, [{ filename: 'src/other.ts', patch: '' }]);

    assert.equal(gated.findings.length, 1);
});

test('the reported total agrees with what survived', async () => {
    const diffFiles = patchFor([
        '+  const body = parse(req.body);',
        '+  if (!body.ok) throw new Error("no");',
        '+const dupe = { a: 1, a: 2 };',
    ]);
    const lint = lintWith([
        { ruleId: 'no-unreachable', line: 2, filePath: 'src/api.ts' },
        { ruleId: 'no-dupe-keys', line: 3, filePath: 'src/api.ts' },
    ]);

    const { lint: gated, refuted } = applyPremiseGate(lint, diffFiles);

    assert.equal(refuted.length, 1);
    assert.equal(gated.findings.length, 1);
    assert.equal(
        gated.totalFindings,
        1,
        'totalFindings still counted the refuted finding — the bundle would contradict itself',
    );
});

test('a lint result with no findings passes through untouched', async () => {
    const { lint: gated, refuted } = applyPremiseGate(lintWith([]), patchFor(['+const a = 1;']));
    assert.equal(gated.findings.length, 0);
    assert.equal(refuted.length, 0);
});

test('does not mutate the lint result it was given', async () => {
    const diffFiles = patchFor(['+const a = 1;', '+const b = 2;']);
    const lint = lintWith([{ ruleId: 'no-dupe-keys', line: 1, filePath: 'src/api.ts' }]);

    applyPremiseGate(lint, diffFiles);

    assert.equal(lint.findings.length, 1, 'the caller\'s object was mutated');
});

/**
 * Findings on code this change did not touch.
 *
 * The premise gate can only judge a line it can find in the patch —
 * `checkStaticPremise` returns `ok` when the cited line is not in the diff at
 * all, deferring to "GATE 1's job in findingEvidence", which the MCP path also
 * never applied. Once whole files at the reviewed revision are linted (the fix
 * for the wrong-revision defect), most findings land on untouched code: the
 * re-review of the original merge request produced 94 findings, including
 * `no-dupe-keys` at `tool-handlers-merged.ts:242` in a file whose diff starts
 * near line 920, and eleven `no-sql-injection` criticals in code the change
 * never opened.
 *
 * A review is about the change. Pre-existing findings are counted and named,
 * not mixed in with findings about the diff.
 */

test('separates findings on changed lines from findings on untouched code', async () => {
    const diffFiles = [{
        filename: 'src/api.ts',
        patch: [
            '@@ -40,2 +40,3 @@',
            ' const untouched = 1;',
            '+const added = { a: 1, a: 2 };',
            ' const alsoUntouched = 2;',
        ].join('\n'),
    }];
    const lint = {
        success: true,
        files: [{
            filePath: 'src/api.ts',
            findings: [
                { ruleId: 'no-dupe-keys', line: 41, filePath: 'src/api.ts' },
                { ruleId: 'no-dupe-keys', line: 242, filePath: 'src/api.ts' },
            ],
        }],
        findings: [
            { ruleId: 'no-dupe-keys', line: 41, filePath: 'src/api.ts' },
            { ruleId: 'no-dupe-keys', line: 242, filePath: 'src/api.ts' },
        ],
        totalFindings: 2,
    };

    const { lint: gated, outsideDiff } = applyPremiseGate(lint, diffFiles);

    assert.deepEqual(gated.findings.map((f) => f.line), [41]);
    assert.equal(outsideDiff.length, 1);
    assert.equal(outsideDiff[0].line, 242);
});

test('a finding for a file with no patch is not called outside the diff', async () => {
    const lint = {
        success: true,
        files: [{ filePath: 'src/other.ts', findings: [{ ruleId: 'x', line: 9, filePath: 'src/other.ts' }] }],
        findings: [{ ruleId: 'x', line: 9, filePath: 'src/other.ts' }],
        totalFindings: 1,
    };

    const { lint: gated, outsideDiff } = applyPremiseGate(lint, []);

    assert.equal(gated.findings.length, 1);
    assert.equal(outsideDiff.length, 0);
});

test('a finding with no line at all is kept rather than guessed about', async () => {
    const diffFiles = [{ filename: 'src/api.ts', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' }];
    const lint = {
        success: true,
        files: [{ filePath: 'src/api.ts', findings: [{ ruleId: 'secret', filePath: 'src/api.ts' }] }],
        findings: [{ ruleId: 'secret', filePath: 'src/api.ts' }],
        totalFindings: 1,
    };

    const { lint: gated, outsideDiff } = applyPremiseGate(lint, diffFiles);

    assert.equal(gated.findings.length, 1);
    assert.equal(outsideDiff.length, 0);
});

test('the rendered section reports the pre-existing count without listing all of it', async () => {
    const result = {
        lint: { findings: [{ ruleId: 'a', severity: 'medium', line: 1, filePath: 'x.ts' }] },
        secrets: [],
        source: { kind: 'revision', rev: 'abc', reason: 'r' },
        engines: { regex: 1 },
        premiseRefuted: [],
        outsideDiff: Array.from({ length: 47 }, (_unused, i) => ({
            ruleId: 'no-unreachable', filePath: 'x.ts', line: 100 + i,
        })),
        filesLinted: ['x.ts'],
    };

    const parsed = JSON.parse(renderStaticSection(result, 100000));

    assert.equal(parsed.findingsOutsideDiffTotal, 47);
    assert.ok(
        (parsed.findingsOutsideDiff || []).length < 47,
        'the whole pre-existing list is carried, which is what crowded out the diff findings',
    );
    assert.match(parsed.findingsOutsideDiffNote || '', /not part of this change|pre-existing/i);
});

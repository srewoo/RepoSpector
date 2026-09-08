import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStaticSection } from '../src/tools/staticFindings.js';

/**
 * How the static section survives a budget.
 *
 * Found by re-reviewing the merge request that started all of this: with the
 * real bundle at 90k tokens the section still overran and `capText` cut it at
 * a line boundary — **8494 of 9995 lines not shown**. The cut is honest, but
 * the loss was not arbitrary: `engines`, `premiseRefuted` and `source` are the
 * newest and smallest facts in the section and they sat LAST in the object, so
 * budgeting deleted precisely the qualifications that stop a regex artifact
 * being read as a fact, while keeping per-file `individualResults` boilerplate.
 *
 * Two fixes, both pinned here: the qualifying fields come first, and the
 * section re-renders inside its grant by dropping findings from the tail
 * rather than being sliced mid-JSON.
 */

const finding = (i) => ({
    ruleId: 'no-dupe-keys',
    severity: 'medium',
    category: 'bug',
    message: 'Duplicate keys in object literal',
    line: i,
    column: 1,
    endLine: i,
    endColumn: 80,
    filePath: 'src/a.ts',
    tool: 'eslint',
    engine: 'regex',
    confidence: 0.5,
    cwe: 'CWE-561',
    codeSnippet: `   ${i} | ${'x'.repeat(400)}`,
    matchedText: 'y'.repeat(400),
    // Scorer internals that only burn context.
    baseConfidence: 0.5,
    correlationBonus: 0,
    toolsDetected: ['eslint'],
    relatedFindings: [],
    isCorroborated: false,
});

const result = (n) => ({
    lint: {
        success: true,
        totalFindings: n,
        findings: Array.from({ length: n }, (_unused, i) => finding(i + 1)),
        files: [{
            success: true,
            filePath: 'src/a.ts',
            findings: Array.from({ length: n }, (_unused, i) => finding(i + 1)),
            summary: { total: n, bySeverity: { critical: 0, high: 0, medium: n, low: 0 } },
            // The single biggest contributor to the overrun, and of no use to a
            // reviewer: every analyzer's raw per-file output, repeated.
            individualResults: {
                eslint: { engine: 'regex', findings: Array.from({ length: n }, (_u, i) => finding(i + 1)) },
                semgrep: { findings: [] },
            },
            correlation: { pairs: Array.from({ length: 50 }, () => ({ a: 1, b: 2 })) },
        }],
    },
    secrets: { findings: [], scanned: 1 },
    source: { kind: 'revision', rev: 'abc123', reason: 'read at the head', missing: ['gone.ts'] },
    engines: { regex: 1 },
    premiseRefuted: [
        { ruleId: 'no-unreachable', filePath: 'src/a.ts', line: 81, reason: 'mis-mapped' },
    ],
    filesLinted: ['src/a.ts'],
});

test('the qualifying facts come before the findings', () => {
    const text = renderStaticSection(result(3), 100000);
    const keys = Object.keys(JSON.parse(text));

    assert.deepEqual(
        keys.slice(0, 5),
        ['source', 'engines', 'premiseRefuted', 'filesLinted', 'secrets'],
        `the qualifications must not sort after the findings: ${keys.join(', ')}`,
    );
});

test('a tight budget still yields valid JSON', () => {
    const text = renderStaticSection(result(200), 400);
    assert.doesNotThrow(
        () => JSON.parse(text),
        'the section was sliced mid-structure — a reader cannot parse or trust it',
    );
});

test('a tight budget keeps the engine, the refusals and the source', () => {
    const parsed = JSON.parse(renderStaticSection(result(200), 400));

    assert.deepEqual(parsed.engines, { regex: 1 });
    assert.equal(parsed.premiseRefuted.length, 1);
    assert.equal(parsed.source.kind, 'revision');
});

test('findings dropped for budget are counted, not silently missing', () => {
    const parsed = JSON.parse(renderStaticSection(result(200), 400));

    assert.ok(parsed.findings.length < 200, 'nothing was dropped, so this asserts nothing');
    assert.equal(parsed.findingsTotal, 200);
    assert.match(parsed.findingsNote || '', /not shown|omitted|dropped/i);
});

test('scorer internals and per-analyzer dumps are not carried at all', () => {
    const text = renderStaticSection(result(3), 100000);

    for (const noise of ['individualResults', 'correlation', 'baseConfidence',
        'relatedFindings', 'toolsDetected', 'isCorroborated']) {
        assert.doesNotMatch(text, new RegExp(noise), `${noise} is scorer internals`);
    }
});

test('a finding keeps what a reviewer acts on', () => {
    const parsed = JSON.parse(renderStaticSection(result(1), 100000));
    const f = parsed.findings[0];

    for (const key of ['ruleId', 'severity', 'message', 'filePath', 'line', 'engine']) {
        assert.ok(f[key] !== undefined, `a finding lost ${key}`);
    }
});

test('the highest severity findings survive a budget first', () => {
    const r = result(50);
    r.lint.findings[40] = { ...finding(41), severity: 'critical', ruleId: 'no-eval' };

    const parsed = JSON.parse(renderStaticSection(r, 400));

    assert.ok(
        parsed.findings.some((f) => f.severity === 'critical'),
        'a critical finding was dropped while medium ones were kept',
    );
});

test('a clean result says so rather than rendering an empty shell', () => {
    const clean = {
        ...result(0),
        lint: { success: true, totalFindings: 0, findings: [], files: [] },
    };

    const parsed = JSON.parse(renderStaticSection(clean, 100000));

    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.findingsTotal, 0);
});

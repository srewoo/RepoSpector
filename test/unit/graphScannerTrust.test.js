/**
 * P1-3 — a graph edge or a scanner match is a candidate, not a proven defect.
 *
 * Two halves of one trust bypass:
 *
 *   The SIGNATURE RULE asserted, at severity `high` and in the reviewer's own
 *   voice, that callers outside the PR "still pass the old argument list" —
 *   from a signature diff and a set of graph edges, without reading a single
 *   call expression. `CallGraphBuilder` resolves some of those edges by name,
 *   so an unrelated same-named symbol or a stale index produced the same
 *   confident claim.
 *
 *   The RE-ADD appended scanner, graph and missing-test findings after the
 *   precision gate on the reasoning that they are not model output. True, and
 *   it turned into "needs no validation": all three were reported in the same
 *   voice as a defect the pipeline had established.
 */
const {
    checkCallSite,
    checkCallers,
    callArgumentsAt,
    CALL_SITE,
} = require('../../src/utils/callSiteCheck.js');
const {
    admitDeterministic,
    describeAssertion,
    ASSERTION,
} = require('../../src/utils/deterministicAdmission.js');
const { stitchChunksByLine } = require('../../src/utils/indexedSource.js');
const { findingBlocks } = require('../../src/utils/failLevel.js');

describe('reading a call expression', () => {
    const source = [
        'function a() {',
        '  return charge(total, "USD");',
        '}',
        'function b() {',
        '  return charge(wrap(x, y), z);',
        '}',
    ].join('\n');

    it('counts arguments, not commas', () => {
        expect(callArgumentsAt(source, 'charge', 5).count).toBe(2);
    });

    it('does not match a longer identifier that contains the symbol', () => {
        expect(callArgumentsAt('return recharge(a, b, c);', 'charge', 1)).toBeNull();
    });

    it('ignores commas inside strings', () => {
        expect(callArgumentsAt('charge("a,b,c");', 'charge', 1).count).toBe(1);
    });
});

describe('classifying one call site against a signature change', () => {
    const change = { before: ['amount', 'currency'], after: ['amount'] };

    it('an over-supplied call under a narrowed signature is incompatible', () => {
        const r = checkCallSite(change, { filePath: 'a.js', line: 1 }, 'charge', 'charge(total, "USD");');
        expect(r.status).toBe(CALL_SITE.INCOMPATIBLE);
        expect(r.call).toBe('(total, "USD")');
    });

    it('a call that already matches is compatible', () => {
        const r = checkCallSite(change, { filePath: 'a.js', line: 1 }, 'charge', 'charge(total);');
        expect(r.status).toBe(CALL_SITE.COMPATIBLE);
    });

    it('an optional new parameter is not required', () => {
        const widened = { before: ['a'], after: ['a', 'b = 1'] };
        expect(checkCallSite(widened, { filePath: 'x.js', line: 1 }, 'f', 'f(1);').status)
            .toBe(CALL_SITE.COMPATIBLE);
    });

    it('a rest parameter accepts any number of arguments', () => {
        const rest = { before: ['a'], after: ['a', '...more'] };
        expect(checkCallSite(rest, { filePath: 'x.js', line: 1 }, 'f', 'f(1, 2, 3, 4);').status)
            .toBe(CALL_SITE.COMPATIBLE);
    });

    it('a spread call is dynamic, not incompatible', () => {
        const r = checkCallSite(change, { filePath: 'a.js', line: 1 }, 'charge', 'charge(...args);');
        expect(r.status).toBe(CALL_SITE.DYNAMIC);
    });

    it('a graph edge pointing at a file with no such call is NOT-FOUND', () => {
        const r = checkCallSite(change, { filePath: 'a.js', line: 1 }, 'charge', 'const x = 1;');
        expect(r.status).toBe(CALL_SITE.NOT_FOUND);
        expect(r.reason).toMatch(/name-resolved, stale/);
    });

    it('no source at all is UNKNOWN — never "still passes the old list"', () => {
        const r = checkCallSite(change, { filePath: 'a.js', line: 1 }, 'charge', null);
        expect(r.status).toBe(CALL_SITE.UNKNOWN);
    });

    it('a batch is only "verified" when every caller was read', () => {
        const callers = [{ filePath: 'a.js', line: 1 }, { filePath: 'b.js', line: 1 }];
        const partial = checkCallers(change, callers, 'charge', (p) => (p === 'a.js' ? 'charge(x, y);' : null));
        expect(partial.incompatible).toHaveLength(1);
        expect(partial.unverified).toHaveLength(1);
        expect(partial.verified).toBe(false);
    });

    it('a readSource that throws degrades to unverified rather than failing', () => {
        const r = checkCallers(change, [{ filePath: 'a.js', line: 1 }], 'charge', () => {
            throw new Error('index unavailable');
        });
        expect(r.unverified).toHaveLength(1);
    });
});

describe('indexed chunks are reassembled at their real line numbers', () => {
    it('places each chunk at its recorded start line', () => {
        const text = stitchChunksByLine([
            { startLine: 3, content: 'line three\nline four' },
            { startLine: 10, content: 'line ten' },
        ]);
        const lines = text.split('\n');
        expect(lines[2]).toBe('line three');
        expect(lines[3]).toBe('line four');
        expect(lines[9]).toBe('line ten');
        // The gap is blank, not collapsed — collapsing is what made every
        // recorded line number wrong.
        expect(lines[5]).toBe('');
    });

    it('refuses to reconstruct when no chunk carries a line number', () => {
        expect(stitchChunksByLine([{ content: 'anything' }])).toBeNull();
    });
});

describe('deterministic findings are admitted, not waved through', () => {
    const scanner = { file: 'a.js', line: 3, tool: 'codeql', ruleId: 'js/sql-injection', severity: 'high' };

    it('a scanner finding is reported as reported, not as reproduced', () => {
        const { admitted } = admitDeterministic([scanner], 'scanner', { revision: 'abc123' });
        expect(admitted[0].assertionLevel).toBe(ASSERTION.TOOL_REPORTED);
        expect(admitted[0].attribution).toMatchObject({ kind: 'scanner', tool: 'codeql', revision: 'abc123' });
        expect(describeAssertion(admitted[0].assertionLevel)).toMatch(/not independently reproduced/);
    });

    it('a scanner finding with no rule id is not reportable', () => {
        const { admitted, rejected } = admitDeterministic([{ ...scanner, ruleId: null }], 'scanner');
        expect(admitted).toHaveLength(0);
        expect(rejected[0]._admissionDrop).toMatch(/missing provenance/);
    });

    it('an unverified graph finding keeps its advisory level and cannot block', () => {
        const inferred = {
            file: 'a.js', line: 1, rule: 'graph/signature-changed-callers',
            severity: 'medium', assertionLevel: ASSERTION.GRAPH_INFERRED, deterministic: true,
        };
        const { admitted } = admitDeterministic([inferred], 'graph');
        expect(admitted[0].assertionLevel).toBe(ASSERTION.GRAPH_INFERRED);
        expect(admitted[0].blocking).toBe(false);
        expect(findingBlocks(admitted[0], 'high')).toBe(false);
    });

    it('a validated graph finding may block', () => {
        const validated = {
            file: 'a.js', line: 1, rule: 'graph/signature-changed-callers',
            severity: 'high', assertionLevel: ASSERTION.VALIDATED, deterministic: true,
        };
        const { admitted } = admitDeterministic([validated], 'graph');
        expect(admitted[0].blocking).toBe(true);
        expect(findingBlocks(admitted[0], 'high')).toBe(true);
    });

    it('a missing-test signal stays advisory', () => {
        const { admitted } = admitDeterministic(
            [{ file: 'a.js', line: 1, rule: 'static/missing-test', severity: 'low' }],
            'missing-test',
        );
        expect(admitted).toHaveLength(1);
        expect(admitted[0].blocking).toBe(false);
    });

    it('counts what was admitted at each level, so a report can say so', () => {
        const { stats } = admitDeterministic(
            [scanner, { ...scanner, ruleId: 'js/xss' }],
            'scanner',
        );
        expect(stats).toMatchObject({ kind: 'scanner', in: 2, admitted: 2, rejected: 0 });
        expect(stats.byAssertion[ASSERTION.TOOL_REPORTED]).toBe(2);
    });
});

describe('the two clauses that turn scanners and coverage into false regressions', () => {
    /**
     * P1-3's acceptance names both explicitly, and both share one shape: an
     * observation about code that was ALREADY like that gets reported as
     * something this change did.
     */

    it('a PRE-EXISTING scanner finding is reported as reported, never as introduced', () => {
        // The scanner is describing the repository, not the diff. Nothing in a
        // SARIF record says "this change caused it", so nothing downstream may.
        const preExisting = {
            file: 'src/legacy.js', line: 400, tool: 'codeql', ruleId: 'js/weak-hash',
            severity: 'high', introducedBy: null,
        };
        const { admitted } = admitDeterministic([preExisting], 'scanner', { revision: 'head1' });

        expect(admitted[0].assertionLevel).toBe(ASSERTION.TOOL_REPORTED);
        expect(describeAssertion(admitted[0].assertionLevel)).toMatch(/not independently reproduced/);
        // Never promoted to the level that means "checked against source in
        // this review", which is what an asserted regression would require.
        expect(admitted[0].assertionLevel).not.toBe(ASSERTION.VALIDATED);
    });

    it('a scanner finding cannot block a merge on severity alone', () => {
        // `deterministic: true` used to be sufficient. A scanner match on
        // pre-existing code blocking a merge is the practical form of the
        // "pre-existing finding became an asserted regression" failure.
        const { admitted } = admitDeterministic(
            [{ file: 'src/legacy.js', line: 400, tool: 'codeql', ruleId: 'js/weak-hash', severity: 'high' }],
            'scanner',
        );
        expect(admitted[0].blocking).toBe(false);
        expect(findingBlocks(admitted[0], 'high')).toBe(false);
    });

    it('AMBIGUOUS test coverage stays advisory rather than becoming a defect', () => {
        // "No test mentions this symbol" is a statement about a name search,
        // not about coverage: the behaviour may be covered by a test that never
        // names it. Advisory, and unable to block.
        const { admitted } = admitDeterministic([{
            file: 'src/pricing.js', line: 1, rule: 'static/missing-test', severity: 'low',
            title: 'New exported `calculateWidgetPrice` is not mentioned by any test in this PR',
        }], 'missing-test');

        expect(admitted).toHaveLength(1);
        expect(admitted[0].assertionLevel).toBe(ASSERTION.GRAPH_INFERRED);
        expect(admitted[0].blocking).toBe(false);
        expect(findingBlocks(admitted[0], 'high')).toBe(false);
    });

    it('a stale graph produces a question, and the reason names the staleness', () => {
        // A graph edge whose call site no longer exists is exactly what a stale
        // index looks like from here.
        const r = checkCallers(
            { before: ['a', 'b'], after: ['a'] },
            [{ filePath: 'src/gone.js', line: 10 }],
            'charge',
            () => 'const unrelated = 1;\n'.repeat(20),
        );
        expect(r.incompatible).toHaveLength(0);
        expect(r.unverified[0].status).toBe(CALL_SITE.NOT_FOUND);
        expect(r.unverified[0].reason).toMatch(/stale/);
    });
});

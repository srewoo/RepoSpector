/**
 * Two policies that were previously implicit. What is being tested is mostly
 * that each one is now a STATEMENT: the filter mode says which lines it will
 * report on and holds to it, and the fail level says what blocks a merge and
 * nothing else decides that.
 */

const {
    FILTER_MODE,
    FILTER_MODE_DEFAULT,
    normalizeFilterMode,
    allowedLines,
    applyFilterMode,
    describeFilterMode,
    relocationNote,
} = require('../../src/utils/findingFilterMode.js');

const {
    FAIL_LEVEL,
    FAIL_LEVEL_DEFAULT,
    normalizeFailLevel,
    findingBlocks,
    decideFailure,
    describeFailLevel,
} = require('../../src/utils/failLevel.js');

// Lines 10-12 are context, 11 is added.
const PATCH = [
    '@@ -10,3 +10,4 @@',
    '     const a = 1;',
    '+    const b = 2;',
    '     const c = 3;',
    '     return a;',
].join('\n');

const FILES = [{ filename: 'src/a.js', patch: PATCH }];

const finding = (over = {}) => ({ filePath: 'src/a.js', line: 11, severity: 'high', ...over });

describe('normalizeFilterMode', () => {
    it('accepts the four modes, in any spelling', () => {
        expect(normalizeFilterMode('added')).toBe(FILTER_MODE.ADDED);
        expect(normalizeFilterMode('DIFF-CONTEXT')).toBe(FILTER_MODE.DIFF_CONTEXT);
        expect(normalizeFilterMode(' diff_context ')).toBe(FILTER_MODE.DIFF_CONTEXT);
        expect(normalizeFilterMode('nofilter')).toBe(FILTER_MODE.NOFILTER);
    });

    it('falls back to the default, never to nofilter', () => {
        // A typo must not silently widen the scope to the whole repository.
        for (const junk of ['', 'everything', null, 42, undefined]) {
            expect(normalizeFilterMode(junk)).toBe(FILTER_MODE_DEFAULT);
        }
        expect(FILTER_MODE_DEFAULT).toBe(FILTER_MODE.ADDED);
    });
});

describe('allowedLines', () => {
    it('added mode allows only added lines', () => {
        const { lines } = allowedLines(PATCH, FILTER_MODE.ADDED);
        expect([...lines]).toEqual([11]);
    });

    it('diff_context mode also allows context lines', () => {
        const { lines } = allowedLines(PATCH, FILTER_MODE.DIFF_CONTEXT);
        expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    });

    it('file and nofilter allow any line', () => {
        expect(allowedLines(PATCH, FILTER_MODE.FILE).lines).toBeNull();
        expect(allowedLines(PATCH, FILTER_MODE.NOFILTER).lines).toBeNull();
    });
});

describe('applyFilterMode', () => {
    it('keeps a finding on an added line', () => {
        const { kept, stats } = applyFilterMode([finding()], FILES);
        expect(kept).toHaveLength(1);
        expect(stats.kept).toBe(1);
        expect(kept[0].relocated).toBeUndefined();
    });

    it('drops a finding on a context line in added mode', () => {
        const { kept, dropped, stats } = applyFilterMode([finding({ line: 13 })], FILES);
        // 13 is 2 lines from 11, inside the snap window — so it relocates rather
        // than dropping. This is the documented behaviour, and the point of the
        // next test is that it is VISIBLE.
        expect(kept).toHaveLength(1);
        expect(stats.relocated).toBe(1);
        expect(dropped).toHaveLength(0);
    });

    it('records a relocation instead of moving a finding silently', () => {
        // The reviewer otherwise reads a precise line number nobody asserted.
        const { kept } = applyFilterMode([finding({ line: 13 })], FILES);
        expect(kept[0].line).toBe(11);
        expect(kept[0].relocated).toEqual({ from: 13, to: 11, distance: 2 });
        expect(relocationNote(kept[0])).toMatch(/reported on line 13/);
    });

    it('drops a finding beyond the snap window', () => {
        const { kept, dropped, stats } = applyFilterMode([finding({ line: 400 })], FILES);
        expect(kept).toHaveLength(0);
        expect(stats.droppedOutsideDiff).toBe(1);
        expect(dropped[0].filteredBecause).toMatch(/outside lines this PR added/);
    });

    it('gives diff_context a wider snap window than added', () => {
        const strict = applyFilterMode([finding({ line: 16 })], FILES, { mode: FILTER_MODE.ADDED });
        const loose = applyFilterMode([finding({ line: 16 })], FILES, { mode: FILTER_MODE.DIFF_CONTEXT });
        expect(strict.kept).toHaveLength(0);
        expect(loose.kept).toHaveLength(1); // 16 is 3 from 13, within 5
    });

    it('file mode keeps any line in a changed file', () => {
        const { kept } = applyFilterMode([finding({ line: 9999 })], FILES, { mode: FILTER_MODE.FILE });
        expect(kept).toHaveLength(1);
        expect(kept[0].relocated).toBeUndefined();
    });

    it('file mode still rejects a file the PR did not change', () => {
        const { kept, stats } = applyFilterMode(
            [finding({ filePath: 'src/untouched.js' })], FILES, { mode: FILTER_MODE.FILE },
        );
        expect(kept).toHaveLength(0);
        expect(stats.droppedUnknownFile).toBe(1);
    });

    it('nofilter keeps everything, including unknown files', () => {
        const { kept, dropped } = applyFilterMode(
            [finding({ filePath: 'anything.js', line: 1 })], FILES, { mode: FILTER_MODE.NOFILTER },
        );
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(0);
    });

    it('keeps a line-less finding as a file-level statement', () => {
        // "This file's new dependency is vulnerable" has no line and is valid.
        const { kept } = applyFilterMode([finding({ line: null })], FILES);
        expect(kept).toHaveLength(1);
    });

    it('can be told to reject file-level findings', () => {
        const { kept, stats } = applyFilterMode(
            [finding({ line: null })], FILES, { allowFileLevel: false },
        );
        expect(kept).toHaveLength(0);
        expect(stats.droppedNoLine).toBe(1);
    });

    it('reads `file` as well as `filePath`', () => {
        const { kept } = applyFilterMode([{ file: 'src/a.js', line: 11 }], FILES);
        expect(kept).toHaveLength(1);
    });

    it('accounts for every finding it was given', () => {
        const findings = [
            finding(),                                  // kept
            finding({ line: 13 }),                      // relocated
            finding({ line: 500 }),                     // outside
            finding({ filePath: 'nope.js', line: 1 }),  // unknown file
        ];
        const { kept, dropped, stats } = applyFilterMode(findings, FILES);
        expect(stats.in).toBe(4);
        expect(kept.length + dropped.length).toBe(4);
        expect(stats.kept).toBe(2);
        expect(stats.droppedOutsideDiff).toBe(1);
        expect(stats.droppedUnknownFile).toBe(1);
    });

    it('handles empty inputs', () => {
        expect(applyFilterMode([], FILES).kept).toEqual([]);
        expect(applyFilterMode([finding()], []).kept).toEqual([]);
    });
});

describe('describeFilterMode', () => {
    it('always states the scope, even when nothing was dropped', () => {
        // A reviewer who knows the scope can tell "clean" from "out of scope".
        const { stats } = applyFilterMode([finding()], FILES);
        expect(describeFilterMode(stats)).toBe('Findings scoped to lines this PR added.');
    });

    it('reports drops and relocations', () => {
        const { stats } = applyFilterMode(
            [finding({ line: 13 }), finding({ line: 500 })], FILES,
        );
        const text = describeFilterMode(stats);
        expect(text).toMatch(/1 finding\(s\) outside that scope were not reported/);
        expect(text).toMatch(/1 finding\(s\) were moved/);
    });

    it('is empty for no stats', () => {
        expect(describeFilterMode(null)).toBe('');
    });
});

describe('normalizeFailLevel', () => {
    it('accepts the levels', () => {
        expect(normalizeFailLevel('none')).toBe(FAIL_LEVEL.NONE);
        expect(normalizeFailLevel('ANY')).toBe(FAIL_LEVEL.ANY);
        expect(normalizeFailLevel(' critical ')).toBe(FAIL_LEVEL.CRITICAL);
    });

    it('falls back to the default, never to none', () => {
        // A typo must not silently disable a team's merge gate.
        for (const junk of ['', 'blocker', null, 7]) {
            expect(normalizeFailLevel(junk)).toBe(FAIL_LEVEL_DEFAULT);
        }
        expect(FAIL_LEVEL_DEFAULT).toBe(FAIL_LEVEL.HIGH);
    });
});

describe('findingBlocks', () => {
    it('requires an LLM finding to be marked blocking as well as severe', () => {
        // It has already been through the evidence gates; one that failed them
        // has no business blocking a merge however severe it claims to be.
        expect(findingBlocks({ severity: 'critical' }, 'high')).toBe(false);
        expect(findingBlocks({ severity: 'critical', blocking: true }, 'high')).toBe(true);
    });

    it('judges a deterministic finding on severity alone', () => {
        // A scanner either matched or it did not.
        expect(findingBlocks({ severity: 'high', deterministic: true }, 'high')).toBe(true);
        expect(findingBlocks({ severity: 'low', deterministic: true }, 'high')).toBe(false);
    });

    it('never blocks at level none', () => {
        expect(findingBlocks({ severity: 'critical', deterministic: true }, 'none')).toBe(false);
    });

    it('blocks on anything at level any', () => {
        expect(findingBlocks({ severity: 'info' }, 'any')).toBe(true);
    });

    it('respects the threshold', () => {
        const f = (s) => ({ severity: s, deterministic: true });
        expect(findingBlocks(f('medium'), 'high')).toBe(false);
        expect(findingBlocks(f('high'), 'high')).toBe(true);
        expect(findingBlocks(f('high'), 'critical')).toBe(false);
        expect(findingBlocks(f('critical'), 'critical')).toBe(true);
        expect(findingBlocks(f('low'), 'low')).toBe(true);
    });

    it('treats an unknown severity as unblocking rather than guessing', () => {
        expect(findingBlocks({ severity: 'spicy', deterministic: true }, 'high')).toBe(false);
    });
});

describe('decideFailure', () => {
    const det = (s) => ({ severity: s, deterministic: true, ruleId: 'r' });

    it('preserves the old behaviour at the default level', () => {
        // Previously: blockingCount > 0 → REQUEST_CHANGES, where blocking
        // findings are high/critical.
        const d = decideFailure([{ severity: 'high', blocking: true }]);
        expect(d.blocks).toBe(true);
        expect(d.verdict).toBe('CHANGES_REQUESTED');
        expect(d.reviewEvent).toBe('REQUEST_CHANGES');
    });

    it('passes when nothing meets the bar', () => {
        const d = decideFailure([det('medium'), det('low')]);
        expect(d.blocks).toBe(false);
        expect(d.reviewEvent).toBeNull();
        expect(d.reason).toMatch(/no finding at or above high/);
    });

    it('lets a team comment on everything and block on nothing', () => {
        // The point of separating the two decisions: previously the only way to
        // stop blocking on a finding was to stop reporting it.
        const d = decideFailure([det('critical')], { failLevel: 'none' });
        expect(d.blocks).toBe(false);
        expect(d.reason).toMatch(/never blocks/);
    });

    it('lets a team block on anything', () => {
        expect(decideFailure([det('info')], { failLevel: 'any' }).blocks).toBe(true);
    });

    it('names what blocked, by severity', () => {
        const d = decideFailure([det('critical'), det('high'), det('high'), det('low')]);
        expect(d.blockingFindings).toHaveLength(3);
        expect(d.reason).toMatch(/1 critical/);
        expect(d.reason).toMatch(/2 high/);
    });

    it('handles an empty finding set', () => {
        const d = decideFailure([]);
        expect(d.blocks).toBe(false);
    });
});

describe('describeFailLevel', () => {
    it('speaks whether or not it fired', () => {
        // A gate that only speaks when it fires leaves the reader guessing what
        // would have fired.
        const passed = describeFailLevel(decideFailure([{ severity: 'low' }]));
        expect(passed).toMatch(/passed/);
        expect(passed).toMatch(/threshold: high/);

        const blocked = describeFailLevel(decideFailure([{ severity: 'high', blocking: true }]));
        expect(blocked).toMatch(/blocking/);
    });

    it('says so when the gate is off', () => {
        expect(describeFailLevel(decideFailure([], { failLevel: 'none' }))).toMatch(/off/);
    });

    it('is empty for no decision', () => {
        expect(describeFailLevel(null)).toBe('');
    });
});

/**
 * P1-1 — removals are behaviour changes.
 *
 * The defect: `stripDeletionOnlyHunks` dropped every deletion-only hunk before
 * the prompt was built, and the prompt then told the model never to report a
 * finding against a removed line. Between them, deleting an authorization
 * check, a rollback, a resource release, an exported symbol or the only test
 * for a branch was unreportable — and unreportable silently, inside a review
 * that read as complete.
 *
 * The negative control matters as much as the positives: genuinely dead code
 * must still be stripped, or the token saving this guard exists for is gone.
 */
const {
    classifyRemovedLines,
    classifyDeletionHunk,
} = require('../../src/utils/deletionSignificance.js');
const { stripDeletionOnlyHunks, fitFilesToBudget } = require('../../src/utils/diffBudget.js');
const { applyFilterMode, removedRanges } = require('../../src/utils/findingFilterMode.js');

/** A deletion-only hunk removing `body`, at old line 10. */
const deletionHunk = (body) => [
    '@@ -10,4 +10,1 @@',
    ' before();',
    ...body.map((l) => `-${l}`),
    ' after();',
].join('\n');

describe('which removals are worth reviewing', () => {
    const cases = [
        ['an authorization guard', ['  if (!user.hasPermission("write")) {', '    throw new Error("forbidden");', '  }'], 'authorization'],
        ['a rollback', ['  await tx.rollback();'], 'transaction'],
        ['a resource cleanup', ['  socket.removeEventListener("data", onData);'], 'cleanup'],
        ['an exported symbol', ['export function computeTotal(items) {', '  return items.length;', '}'], 'exported-api'],
        ['the sole regression test', ["  it('rejects an expired token', () => {", '    expect(check(expired)).toBe(false);', '  });'], 'test'],
        ['input validation', ['  validateEmail(input.email);'], 'validation'],
        ['a null guard', ['  if (value === null) return fallback;'], 'null-check'],
    ];

    for (const [label, lines, signal] of cases) {
        it(`keeps ${label}`, () => {
            const verdict = classifyRemovedLines(lines);
            expect(verdict.significant).toBe(true);
            expect(verdict.signals.map((s) => s.name)).toContain(signal);
        });
    }

    it('still strips genuinely dead code — the negative control', () => {
        expect(classifyRemovedLines([
            'function unused() {',
            '  const x = 1;',
            '  console.log(x);',
            '}',
        ]).significant).toBe(false);
    });

    it('ignores comments and blank lines', () => {
        expect(classifyRemovedLines([
            '// throw new Error("this is a comment about a throw")',
            '',
            '   ',
        ]).significant).toBe(false);
    });

    it('does not treat every removed `if` as a guard', () => {
        // An `if` with no rejecting consequence is ordinary control flow.
        // Treating it as significant would keep nearly every deletion hunk and
        // give back the entire token saving.
        expect(classifyRemovedLines([
            '  if (mode === "fast") {',
            '    total = total + 1;',
            '  }',
        ]).significant).toBe(false);
    });

    it('reads a hunk directly, using only its removed lines', () => {
        const verdict = classifyDeletionHunk(deletionHunk(['  await tx.rollback();']).split('\n'));
        expect(verdict.significant).toBe(true);
    });
});

describe('stripDeletionOnlyHunks keeps behavioural removals', () => {
    const GUARD = deletionHunk([
        '  if (!req.user.isAdmin) {',
        '    throw new Error("forbidden");',
        '  }',
    ]);
    const DEAD = deletionHunk(['function dead() {', '  return 1;', '}']);

    it('an authorization guard survives into the prompt', () => {
        const res = stripDeletionOnlyHunks(GUARD);
        expect(res.patch).toContain('isAdmin');
        expect(res.keptDeletionHunks).toBe(1);
        expect(res.removedHunks).toBe(0);
        expect(res.deletionSignals[0].signals.map((s) => s.name)).toContain('authorization');
    });

    it('dead code is still stripped', () => {
        const res = stripDeletionOnlyHunks(DEAD);
        expect(res.patch).toBe('');
        expect(res.removedHunks).toBe(1);
        expect(res.keptDeletionHunks).toBe(0);
    });

    it('keeps the significant hunk and strips the dead one from the same patch', () => {
        const res = stripDeletionOnlyHunks(`${GUARD}\n${DEAD}`);
        expect(res.patch).toContain('isAdmin');
        expect(res.patch).not.toContain('function dead()');
        expect(res.keptDeletionHunks).toBe(1);
        expect(res.removedHunks).toBe(1);
    });

    it('the old unconditional behaviour is still available explicitly', () => {
        const res = stripDeletionOnlyHunks(GUARD, { keepSignificant: false });
        expect(res.patch).toBe('');
        expect(res.removedHunks).toBe(1);
    });
});

describe('an all-deletion file is reviewed rather than named and skipped', () => {
    it('a file whose only change removes a guard is sent to the model', () => {
        const files = [{
            filename: 'auth.js',
            patch: deletionHunk(['  if (!hasPermission(user)) throw new Error("no");']),
        }];
        const { included, omitted, stats } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });

        expect(included).toHaveLength(1);
        expect(omitted).toHaveLength(0);
        expect(stats.deletionOnlyHunksKept).toBe(1);
        expect(stats.deletionSignals[0].file).toBe('auth.js');
    });

    it('a file whose only change removes dead code is still named, not shown', () => {
        const files = [{ filename: 'dead.js', patch: deletionHunk(['function dead() { return 1; }']) }];
        const { included, omitted } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });

        expect(included).toHaveLength(0);
        expect(omitted[0].omittedBecause).toBe('no added lines');
    });

    it('mixed units keep the removals of the files that fit', () => {
        const files = [
            { filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
            { filename: 'auth.js', patch: deletionHunk(['  await tx.rollback();']) },
        ];
        const { included } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });
        expect(included.map((f) => f.filename)).toEqual(['a.js', 'auth.js']);
    });
});

describe('a deletion finding is reported, not filtered away', () => {
    const patch = deletionHunk([
        '  if (!user.hasPermission("write")) {',
        '    throw new Error("forbidden");',
        '  }',
    ]);
    const files = [{ filename: 'auth.js', patch }];

    it('identifies which old-side lines were removed, and whether they matter', () => {
        const { ranges } = removedRanges(patch);
        expect(ranges).toHaveLength(1);
        expect(ranges[0]).toMatchObject({ from: 11, to: 13, significant: true });
    });

    it('keeps a finding on a removed line as a file-level statement', () => {
        const { kept, dropped, stats } = applyFilterMode(
            [{ file: 'auth.js', line: 11, title: 'the write permission check was removed' }],
            files,
        );
        expect(dropped).toHaveLength(0);
        expect(kept).toHaveLength(1);
        // File-level, because no inline comment can be placed on a deleted
        // line — a comment PLACEMENT limit, not grounds to discard the defect.
        expect(kept[0].line).toBeNull();
        expect(kept[0].removal).toBe(true);
        expect(kept[0].removedAnchor).toMatchObject({ side: 'old', line: 11, from: 11, to: 13 });
        expect(stats.keptAsRemovalSummary).toBe(1);
    });

    it('honours an explicit old-side claim from the model', () => {
        const { kept } = applyFilterMode(
            [{ file: 'auth.js', oldLine: 12, side: 'old', title: 'removed guard' }],
            files,
        );
        expect(kept[0].removal).toBe(true);
        expect(kept[0].removedAnchor.line).toBe(12);
    });

    it('never relocates a removal finding onto a surviving added line', () => {
        // Snapping would move a claim about deleted code onto code that is
        // still there, which reads as an assertion about the wrong thing.
        const mixed = [{ filename: 'auth.js', patch: `${patch}\n@@ -30,1 +30,2 @@\n keep\n+added()` }];
        const { kept } = applyFilterMode(
            [{ file: 'auth.js', line: 11, title: 'removed guard' }], mixed,
        );
        expect(kept[0].relocated).toBeUndefined();
        expect(kept[0].line).toBeNull();
    });

    it('does not rescue an ordinary finding that merely collides with a removed line number', () => {
        const deadPatch = deletionHunk(['function dead() { return 1; }']);
        const { kept, dropped, stats } = applyFilterMode(
            [{ file: 'dead.js', line: 11, title: 'unrelated claim about new code' }],
            [{ filename: 'dead.js', patch: deadPatch }],
        );
        expect(kept).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(stats.keptAsRemovalSummary).toBe(0);
    });

    it('an added-line finding is unaffected', () => {
        const { kept, stats } = applyFilterMode(
            [{ file: 'a.js', line: 2, title: 'normal finding' }],
            [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b' }],
        );
        expect(kept).toHaveLength(1);
        expect(kept[0].line).toBe(2);
        expect(stats.keptAsRemovalSummary).toBe(0);
    });
});

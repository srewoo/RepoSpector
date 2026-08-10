/**
 * Injected-defect benchmark.
 *
 * The value of this benchmark rests entirely on the ground truth being exact:
 * if a defect is planted at a line other than the one recorded, every detection
 * is scored as a miss and the number is worse than useless. These tests pin the
 * injection contract — right line, added lines only, source files only, and a
 * rewrite that actually changes something.
 */

const {
    DEFECTS,
    defectsFor,
    isInjectable,
    injectIntoFile,
    injectIntoPr,
} = require('../../eval/lib/defects.js');
const { parsePatchHunks } = require('../../src/utils/patchLines.js');

const GO_PATCH = [
    '@@ -10,3 +10,6 @@',
    ' func load(path string) error {',      // new 10 context
    '+\tdata, err := os.ReadFile(path)',    // new 11 added  <- injectable
    '+\tif err != nil {',                   // new 12
    '+\t\treturn err',                      // new 13
    ' }',                                   // new 14
].join('\n');

describe('catalogue', () => {
    it('has a unique id, a category and at least one language per defect', () => {
        const ids = DEFECTS.map(d => d.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const d of DEFECTS) {
            expect(d.category).toMatch(/^(correctness|security)$/);
            expect(d.languages.length).toBeGreaterThan(0);
            expect(typeof d.apply).toBe('function');
        }
    });

    it('selects defects by file extension', () => {
        expect(defectsFor('a.go').map(d => d.id)).toContain('unchecked-error');
        expect(defectsFor('a.go').map(d => d.id)).not.toContain('bare-except');
        expect(defectsFor('a.py').map(d => d.id)).toContain('bare-except');
        expect(defectsFor('a.md')).toEqual([]);
    });
});

describe('isInjectable', () => {
    it('excludes test files — a bug planted in a test is a bug in the test', () => {
        for (const p of [
            'tsdb/db_test.go', 'src/a.spec.ts', 'tests/helpers.py',
            'pkg/testdata/x.go', 'app/__tests__/a.js', 'lib/test_utils.py',
        ]) {
            expect(isInjectable(p)).toBe(false);
        }
    });

    it('excludes vendored and generated code', () => {
        expect(isInjectable('vendor/lib/x.go')).toBe(false);
        expect(isInjectable('dist/bundle.min.js')).toBe(false);
        expect(isInjectable('api/service.pb.go')).toBe(false);
    });

    it('allows ordinary source files, including ones merely named like a test subject', () => {
        expect(isInjectable('tsdb/head_wal.go')).toBe(true);
        expect(isInjectable('src/latest.js')).toBe(true);
        expect(isInjectable('pandas/core/reshape/concat.py')).toBe(true);
    });
});

describe('injectIntoFile', () => {
    it('records the defect at its REAL file line', () => {
        const { patch, injected } = injectIntoFile({ filename: 'pkg/load.go', patch: GO_PATCH });

        expect(injected).toHaveLength(1);
        expect(injected[0].id).toBe('unchecked-error');
        expect(injected[0].line).toBe(11);

        // The recorded line must be where the mutated text actually landed.
        const mutated = parsePatchHunks(patch)
            .flatMap(h => h.lines)
            .find(l => l.number.new === injected[0].line);
        expect(mutated.content).toContain('_ :=');
    });

    it('actually breaks the code', () => {
        const { patch } = injectIntoFile({ filename: 'pkg/load.go', patch: GO_PATCH });
        expect(patch).toContain('data, _ := os.ReadFile(path)');
        expect(patch).not.toContain('data, err := os.ReadFile(path)');
    });

    it('only ever rewrites added lines', () => {
        const before = parsePatchHunks(GO_PATCH).flatMap(h => h.lines).filter(l => l.type !== 'added');
        const { patch } = injectIntoFile({ filename: 'pkg/load.go', patch: GO_PATCH });
        const after = parsePatchHunks(patch).flatMap(h => h.lines).filter(l => l.type !== 'added');
        expect(after.map(l => l.content)).toEqual(before.map(l => l.content));
    });

    it('injects nothing into a test file', () => {
        expect(injectIntoFile({ filename: 'pkg/load_test.go', patch: GO_PATCH }).injected).toEqual([]);
    });

    it('injects nothing when no pattern matches', () => {
        const inert = '@@ -1,1 +1,2 @@\n a\n+// just a comment';
        expect(injectIntoFile({ filename: 'pkg/x.go', patch: inert }).injected).toEqual([]);
    });

    it('honours maxPerFile', () => {
        const many = [
            '@@ -1,1 +1,4 @@',
            ' x',
            '+\ta, err := f()',
            '+\tif !ok {',
            '+\tif n >= limit {',
        ].join('\n');
        const { injected } = injectIntoFile({ filename: 'pkg/x.go', patch: many }, { maxPerFile: 2 });
        expect(injected).toHaveLength(2);
    });

    it('uses each defect class at most once per file', () => {
        const twice = [
            '@@ -1,1 +1,3 @@',
            ' x',
            '+\ta, err := f()',
            '+\tb, err := g()',
        ].join('\n');
        const { injected } = injectIntoFile({ filename: 'pkg/x.go', patch: twice }, { maxPerFile: 5 });
        expect(injected.filter(d => d.id === 'unchecked-error')).toHaveLength(1);
    });

    it('can be restricted to specific defect ids', () => {
        const { injected } = injectIntoFile(
            { filename: 'pkg/load.go', patch: GO_PATCH },
            { only: ['boundary-flip'] },
        );
        expect(injected).toEqual([]);
    });

    it('keeps a before/after record so any injection can be audited', () => {
        const { injected } = injectIntoFile({ filename: 'pkg/load.go', patch: GO_PATCH });
        expect(injected[0].before).toContain('err :=');
        expect(injected[0].after).toContain('_ :=');
        expect(injected[0].before).not.toEqual(injected[0].after);
    });
});

describe('injectIntoPr', () => {
    const prData = {
        files: [
            { filename: 'pkg/load.go', patch: GO_PATCH },
            { filename: 'pkg/load_test.go', patch: GO_PATCH },
        ],
    };

    it('leaves the original prData untouched', () => {
        const before = JSON.stringify(prData);
        injectIntoPr(prData);
        expect(JSON.stringify(prData)).toBe(before);
    });

    it('returns every file, mutated or not', () => {
        const { prData: out, injected } = injectIntoPr(prData);
        expect(out.files).toHaveLength(2);
        expect(injected).toHaveLength(1);
        expect(injected[0].file).toBe('pkg/load.go');
    });

    it('respects the per-PR budget', () => {
        const wide = {
            files: Array.from({ length: 10 }, (_, i) => ({ filename: `pkg/f${i}.go`, patch: GO_PATCH })),
        };
        expect(injectIntoPr(wide, { maxPerPr: 3 }).injected).toHaveLength(3);
    });
});

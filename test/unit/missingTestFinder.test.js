/**
 * The missing-test finder.
 *
 * Built after comparing RepoSpector against Bito on four real MRs: the most
 * common finding Bito made that RepoSpector *structurally could not* was "this
 * new function has no unit test". The only test lens is gated on test files
 * being present in the diff, so the case that matters most — code added with no
 * test — had nothing looking at it.
 *
 * The claim is deliberately narrow ("no test MENTIONS it"), because the honest
 * objection from a real MR author was "it's covered by end-to-end tests". A
 * finding that overclaims gets dismissed along with everything else.
 */

const { findMissingTests, shouldRun, isTestPath } = require('../../src/utils/missingTestFinder.js');

const src = (lines) => ['@@ -1,2 +1,8 @@', ...lines].join('\n');
const pr = (files) => ({ files });

describe('finds newly exported symbols with no test', () => {
    it('flags an exported function no test mentions', () => {
        const out = findMissingTests(pr([
            { filename: 'src/walker.js', patch: src(['+export function walk(node) {', '+  return node;', '+}']) },
            { filename: 'test/other.test.js', patch: src(['+it("unrelated", () => {});']) },
        ]));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ file: 'src/walker.js', rule: 'static/missing-test', source: 'static' });
        expect(out[0].line).toBe(1);
    });

    it('concedes what it cannot know, so the finding survives contact with an author', () => {
        const [f] = findMissingTests(pr([
            { filename: 'src/a.js', patch: src(['+export function alpha() {}']) },
            { filename: 'test/b.test.js', patch: src(['+it("x", () => {});']) },
        ]));
        expect(f.description).toMatch(/does not prove it is untested/);
        expect(f.description).toMatch(/integration test may exercise it without naming it/);
    });

    it('caps output — a 40-symbol PR must not yield 40 findings', () => {
        const many = Array.from({ length: 20 }, (_, i) => `+export function fn${i}() {}`);
        const out = findMissingTests(pr([
            { filename: 'src/many.js', patch: src(many) },
            { filename: 'test/t.test.js', patch: src(['+it("x", () => {});']) },
        ]));
        expect(out.length).toBeLessThanOrEqual(5);
    });
});

describe('stays quiet — noise is the failure mode here', () => {
    const withTest = (files) => pr([...files, { filename: 'test/t.test.js', patch: src(['+it("x", () => {});']) }]);

    it('says nothing when a test DOES mention the symbol, wherever that test lives', () => {
        const out = findMissingTests(pr([
            { filename: 'src/gateway.js', patch: src(['+export function stubFetch() {}']) },
            // Deliberately not a mirrored path — most repos do not mirror.
            { filename: 'test/unit/misc.test.js', patch: src(['+stubFetch();']) },
        ]));
        expect(out).toEqual([]);
    });

    it('ignores non-exported helpers — they are tested through their caller', () => {
        expect(findMissingTests(withTest([
            { filename: 'src/a.js', patch: src(['+function internalHelper() {}']) },
        ]))).toEqual([]);
    });

    it('ignores python and go private conventions', () => {
        expect(findMissingTests(withTest([
            { filename: 'src/a.py', patch: src(['+def _private_helper():', '+    pass']) },
        ]))).toEqual([]);
    });

    it('ignores generated and vendored code', () => {
        expect(findMissingTests(withTest([
            { filename: 'app/_pb/knowledge_base_pb2_grpc.py', patch: src(['+def Search(): pass']) },
            { filename: 'vendor/lib/x.js', patch: src(['+export function vendored() {}']) },
        ]))).toEqual([]);
    });

    it('ignores docs, config and lockfiles', () => {
        expect(findMissingTests(withTest([
            { filename: 'README.md', patch: src(['+export function notCode() {}']) },
            { filename: 'config.yaml', patch: src(['+key: value']) },
        ]))).toEqual([]);
    });

    it('does not lecture a PR that touches no test at all', () => {
        // requireTestPresence: a repo with no test convention gets no finding,
        // rather than the same complaint on every PR forever.
        expect(findMissingTests(pr([
            { filename: 'src/a.js', patch: src(['+export function alpha() {}']) },
        ]))).toEqual([]);
        expect(shouldRun([{ filename: 'src/a.js' }])).toBe(false);
        expect(shouldRun([{ filename: 'src/a.js' }, { filename: 'a.test.js' }])).toBe(true);
    });

    it('says nothing about a docs-only PR', () => {
        expect(shouldRun([{ filename: 'README.md' }, { filename: 'docs/a.md' }])).toBe(false);
    });

    it('recognises test paths across ecosystems', () => {
        for (const p of ['a.test.js', 'a.spec.ts', 'foo_test.go', 'tests/test_x.py', '__tests__/a.js', 'FooTest.java']) {
            expect(isTestPath(p)).toBe(true);
        }
        expect(isTestPath('src/latest.js')).toBe(false);
    });
});

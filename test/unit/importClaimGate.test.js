/**
 * The import-claim gate — measured false-positive class 4.
 *
 * "Premise contradicted by a line visible in the hunk — e.g. claiming a symbol is
 * never imported when the import is in the shown context." On the 22-PR corpus
 * this shape is 6 adjudicated false positives and zero true positives.
 *
 * The asymmetry is the whole safety argument and most of this suite: the gate
 * fires only when the import is PRESENT. A diff is a window, so an import that is
 * not visible proves nothing — and refuting on invisibility would delete the
 * genuine missing-import bugs the reviewer exists to catch.
 */

const { assessImportClaim, claimedSymbols } = require('../../src/utils/importClaimGate.js');

const patch = (lines) => ['@@ -1,6 +1,10 @@', ...lines].join('\n');

describe('refutes a missing-import claim contradicted by the diff', () => {
    it('Go: "fmt.Errorf used but fmt not imported" with the import right there', () => {
        const p = patch(['+import "fmt"', '+', '+func f() error { return fmt.Errorf("x") }']);
        const out = assessImportClaim({ title: 'fmt.Errorf used but fmt not imported' }, p);
        expect(out.refuted).toBe(true);
        expect(out.symbol).toBe('fmt');
        expect(out.reason).toMatch(/contradicted by a line the model was shown/);
    });

    it('Python: "NameError: union_categoricals used without import"', () => {
        const p = patch(['+from pandas import union_categoricals', '+x = union_categoricals(a)']);
        expect(assessImportClaim({ title: 'NameError: union_categoricals used without import' }, p).refuted).toBe(true);
    });

    it('JS: a require() counts as bringing the name into scope', () => {
        const p = patch(["+const bytes = require('bytes');", '+bytes.Clone(x);']);
        expect(assessImportClaim({ title: 'Missing import for bytes package used on this line' }, p).refuted).toBe(true);
    });

    it('matches on the qualifier of a dotted call, which is what an import line carries', () => {
        expect(claimedSymbols('fmt.Errorf used but fmt not imported')).toEqual(expect.arrayContaining(['fmt']));
    });
});

describe('does NOT refute — the expensive direction', () => {
    it('stays silent when NO import is visible: a patch is a window, not a file', () => {
        // This is the real missing-import bug the reviewer should catch. The
        // import block usually sits far above the changed lines.
        const p = patch(['+func f() error { return fmt.Errorf("x") }']);
        expect(assessImportClaim({ title: 'fmt.Errorf used but fmt not imported' }, p).refuted).toBe(false);
    });

    it('ignores a DELETED import — a removed import genuinely is gone', () => {
        const p = patch(['-import "fmt"', '+func f() error { return fmt.Errorf("x") }']);
        expect(assessImportClaim({ title: 'fmt.Errorf used but fmt not imported' }, p).refuted).toBe(false);
    });

    it('does not fire on a different symbol that happens to be imported', () => {
        const p = patch(['+import "errors"', '+func f() error { return fmt.Errorf("x") }']);
        expect(assessImportClaim({ title: 'fmt.Errorf used but fmt not imported' }, p).refuted).toBe(false);
    });

    it('does not treat a prefix as a match: `bytes` must not satisfy `bytesutil`', () => {
        const p = patch(['+import "bytes"', '+bytesutil.Clone(x)']);
        expect(assessImportClaim({ title: 'bytesutil not imported' }, p).refuted).toBe(false);
    });

    it('is import-specific — "used without validation" is a nil-check finding, not an import claim', () => {
        // An earlier draft matched a bare "used without" and would have refuted
        // this real class of finding on any file with an import line.
        const p = patch(['+import "fmt"', '+route := e.ToGrafanaRoute()']);
        expect(assessImportClaim({ title: 'Potential nil route from ToGrafanaRoute() used without validation' }, p).refuted).toBe(false);
    });

    it('ignores findings that make no import claim at all', () => {
        const p = patch(['+import "fmt"', '+if (a == b) {}']);
        expect(assessImportClaim({ title: 'Use strict equality' }, p).refuted).toBe(false);
    });

    it('handles a missing or unparsable patch without throwing', () => {
        expect(assessImportClaim({ title: 'fmt not imported' }, '').refuted).toBe(false);
        expect(assessImportClaim({ title: 'fmt not imported' }, 'not a patch').refuted).toBe(false);
        expect(assessImportClaim({}, patch(['+import "fmt"'])).refuted).toBe(false);
    });
});

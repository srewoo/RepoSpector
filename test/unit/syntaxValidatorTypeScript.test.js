const { validateSyntax } = require('../../src/utils/syntaxValidator.js');

describe('validateSyntax — TypeScript generics no longer break JSX or Function-ctor checks', () => {
    it('accepts a typed const with a generic annotation used in a jest test (repro case)', () => {
        const code = 'const m: Map<string, number> = new Map();\n' +
            'it("x", () => { expect(m.size).toBe(0); });';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts a generic function call', () => {
        const code = 'foo<Bar, Baz>(1);';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts a generic type alias', () => {
        const code = 'type Foo<T> = T[];';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts nested generics', () => {
        const code = 'const xs: Array<Record<string, number>> = [];';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('does not misreport real, balanced JSX as an unclosed tag', () => {
        // NOTE: overall `valid` is still false here, but for a reason outside
        // this fix's scope: `validateWithFunctionConstructor` feeds raw code
        // to `new Function()`, which cannot parse untranspiled JSX at all
        // (that is a pre-existing limitation, not one of the two bugs this
        // change addresses). What matters for bug 1 is that `checkJSXSyntax`
        // no longer reports a false JSX_UNCLOSED_TAG/JSX_MISMATCHED_TAG for
        // JSX that is, in fact, correctly balanced.
        const code = 'const el = <div className="a">hi</div>;';
        const result = validateSyntax(code, {});
        const jsxErrors = result.errors.filter(e => e.type.startsWith('JSX_'));
        expect(jsxErrors).toEqual([]);
    });

    it('still reports genuinely unclosed JSX', () => {
        const code = 'const el = <div>hi;';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.type === 'JSX_UNCLOSED_TAG')).toBe(true);
    });

    it('still rejects unbalanced parentheses (bracket matcher untouched)', () => {
        const code = "describe('charge', () => {\n  it('x', () => { expect(charge(1)).toBe(1);\n";
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('still rejects unbalanced braces (bracket matcher untouched)', () => {
        const code = 'function f() { if (true) { return 1;';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('does not regress plain comparisons using < and >', () => {
        const code = 'if (a < b && c > d) {}';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('does not regress arrow functions', () => {
        const code = 'const add = (a) => (b) => a + b;';
        const result = validateSyntax(code, {});
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });
});

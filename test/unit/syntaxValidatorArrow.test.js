const { validateSyntax } = require('../../src/utils/syntaxValidator.js');

describe('validateSyntax — arrow functions no longer read as bracket mismatches', () => {
    it('accepts an ordinary arrow-function jest test', () => {
        const code = "describe('charge', () => {\n  it('returns amount', () => { expect(charge(1)).toBe(1); });\n});";
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts a nested arrow function', () => {
        const code = 'const add = (a) => (b) => a + b;';
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts an async arrow function', () => {
        const code = "const load = async (id) => { return await fetch(id); };";
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts a plain comparison using < and >', () => {
        const code = 'if (a < b && c > d) {}';
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('still rejects genuinely unbalanced parentheses', () => {
        const code = "describe('charge', () => {\n  it('x', () => { expect(charge(1)).toBe(1);\n";
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('still rejects genuinely unbalanced braces', () => {
        const code = 'function f() { if (true) { return 1;';
        const result = validateSyntax(code, { language: 'javascript' });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});

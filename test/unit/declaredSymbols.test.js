const { declarationNewLine, extractDeclaredSymbols, declaresSymbol } = require('../../src/utils/declaredSymbols.js');

const patch = [
    '@@ -10,3 +12,6 @@',
    ' const a = 1;',
    '+export function charge(amount, currency) {',
    '+  return amount;',
    '+}',
    ' const b = 2;',
    '@@ -40,2 +45,3 @@',
    '+class Ledger {}',
].join('\n');

describe('declarationNewLine', () => {
    it('returns the new-file line of a + declaration', () => {
        expect(declarationNewLine(patch, 'charge')).toBe(13);
    });
    it('counts across hunks', () => {
        expect(declarationNewLine(patch, 'Ledger')).toBe(45);
    });
    it('returns null when the symbol is not declared on a + line', () => {
        expect(declarationNewLine(patch, 'a')).toBeNull();
    });
    it('agrees with extractDeclaredSymbols about what a declaration is', () => {
        const added = patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1)).join('\n');
        for (const sym of extractDeclaredSymbols(added)) {
            expect(declarationNewLine(patch, sym)).not.toBeNull();
        }
    });
});

describe('declaresSymbol', () => {
    it('is exact about the name', () => {
        expect(declaresSymbol('export function charge(a) {', 'charge')).toBe(true);
        expect(declaresSymbol('export function charge(a) {', 'charg')).toBe(false);
        expect(declaresSymbol('  return charge(a);', 'charge')).toBe(false);
    });
    it('accepts short names that extractDeclaredSymbols filters out', () => {
        expect(declaresSymbol('def f(a):', 'f')).toBe(true);
    });
    it('covers each supported language form', () => {
        expect(declaresSymbol('class Ledger {}', 'Ledger')).toBe(true);
        expect(declaresSymbol('export const charge = async (', 'charge')).toBe(true);
        expect(declaresSymbol('interface Payment {', 'Payment')).toBe(true);
        expect(declaresSymbol('func (s *S) Charge(a int) {', 'Charge')).toBe(true);
    });
    it('leaves no lastIndex state behind between calls', () => {
        expect(declaresSymbol('export function charge(a) {', 'charge')).toBe(true);
        expect(declaresSymbol('export function charge(a) {', 'charge')).toBe(true);
    });
});

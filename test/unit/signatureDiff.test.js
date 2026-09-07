const { extractParams, declarationLinesFor, signatureChange } = require('../../src/utils/signatureDiff.js');

const patch = (removed, added) => ['@@ -1,2 +1,2 @@', `-${removed}`, `+${added}`].join('\n');

describe('extractParams', () => {
    it('strips defaults, types and whitespace', () => {
        expect(extractParams('export function charge(amount: number, currency = "USD", ...rest) {')).toEqual(['amount', 'currency', '...rest']);
    });
    it('handles python and arrow functions', () => {
        expect(extractParams('def charge(self, amount, currency=None):')).toEqual(['self', 'amount', 'currency']);
        expect(extractParams('export const charge = async (a, b) => {')).toEqual(['a', 'b']);
    });
    it('returns null without a parameter list', () => {
        expect(extractParams('export class Ledger {')).toBeNull();
    });
});

describe('signatureChange', () => {
    it('flags a removed parameter as incompatible', () => {
        const r = signatureChange(patch('export function charge(amount, currency) {', 'export function charge(amount) {'), 'charge');
        expect(r).toMatchObject({ changed: true, compatible: false, before: ['amount', 'currency'], after: ['amount'] });
    });
    it('flags a new required parameter as incompatible', () => {
        const r = signatureChange(patch('function charge(amount) {', 'function charge(amount, currency) {'), 'charge');
        expect(r).toMatchObject({ changed: true, compatible: false });
    });
    it('treats an appended defaulted parameter as compatible', () => {
        const r = signatureChange(patch('function charge(amount) {', 'function charge(amount, currency = "USD") {'), 'charge');
        expect(r).toMatchObject({ changed: true, compatible: true });
    });
    it('flags reordering as incompatible', () => {
        const r = signatureChange(patch('function charge(amount, currency) {', 'function charge(currency, amount) {'), 'charge');
        expect(r).toMatchObject({ changed: true, compatible: false });
    });
    it('reports no change for identical lists', () => {
        const r = signatureChange(patch('function charge(a, b) {', 'function charge(a, b) { // tidy'), 'charge');
        expect(r).toMatchObject({ changed: false });
    });
    it('returns null when the symbol is only added', () => {
        expect(signatureChange(['@@ -1,1 +1,2 @@', ' x', '+function charge(a) {'].join('\n'), 'charge')).toBeNull();
    });
});

describe('declarationLinesFor', () => {
    it('returns both sides', () => {
        const r = declarationLinesFor(patch('def f(a):', 'def f(a, b):'), 'f');
        expect(r).toEqual({ removed: 'def f(a):', added: 'def f(a, b):' });
    });
});

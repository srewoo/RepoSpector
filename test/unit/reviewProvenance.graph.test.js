const { renderGraphSection } = require('../../src/utils/reviewProvenance.js');

describe('renderGraphSection', () => {
    it('renders nothing when the graph was not consulted', () => {
        expect(renderGraphSection(null)).toBe('');
        expect(renderGraphSection({ stats: { symbols: 0 } })).toBe('');
    });
    it('says what the graph checked and what it found', () => {
        const out = renderGraphSection({
            stats: { symbols: 7, signatureChanges: 1, untested: 2, escalations: 0, capped: false },
            rules: { 'graph/signature-changed-callers': 1, 'graph/untested-blast-radius': 2 },
        });
        expect(out).toMatch(/### From the code graph/);
        expect(out).toMatch(/7 changed symbol\(s\)/);
        expect(out).toMatch(/1 signature change/);
        expect(out).toMatch(/2 untested/);
    });
    it('reports a clean check as a positive statement', () => {
        const out = renderGraphSection({ stats: { symbols: 4, signatureChanges: 0, untested: 0, escalations: 0, capped: false }, rules: {} });
        expect(out).toMatch(/no incompatible signature changes/);
    });
    it('mentions the cap when findings were cut', () => {
        const out = renderGraphSection({ stats: { symbols: 20, signatureChanges: 9, untested: 0, escalations: 0, capped: true }, rules: {} });
        expect(out).toMatch(/only the first/);
    });
});

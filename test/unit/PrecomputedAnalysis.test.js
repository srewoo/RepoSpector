const { PrecomputedAnalysis } = require('../../src/services/PrecomputedAnalysis.js');

describe('PrecomputedAnalysis', () => {
    const analysis = {
        symbols: [{ name: 'foo', label: 'Function', startLine: 1, endLine: 3, isExported: true }],
        imports: [{ source: './bar.js' }],
        calls: [{ name: 'bar', line: 2 }],
        heritage: [{ childName: 'A', parentName: 'B', type: 'extends' }]
    };

    it('should report ready only for paths present in the analyses map', () => {
        const pa = new PrecomputedAnalysis(new Map([['src/a.js', analysis]]));
        expect(pa.isReadyForPath('src/a.js')).toBe(true);
        expect(pa.isReadyForPath('src/missing.js')).toBe(false);
    });

    it('should return the stored shapes for a known path', () => {
        const pa = new PrecomputedAnalysis(new Map([['src/a.js', analysis]]));
        expect(pa.getSymbols('', 'src/a.js')).toEqual(analysis.symbols);
        expect(pa.getImports('', 'src/a.js')).toEqual(analysis.imports);
        expect(pa.getCalls('', 'src/a.js')).toEqual(analysis.calls);
        expect(pa.getHeritage('', 'src/a.js')).toEqual(analysis.heritage);
    });

    it('should return null for an unknown path so callers fall back to regex', () => {
        const pa = new PrecomputedAnalysis(new Map([['src/a.js', analysis]]));
        expect(pa.getSymbols('', 'src/unknown.js')).toBeNull();
        expect(pa.getCalls('', 'src/unknown.js')).toBeNull();
    });

    it('should accept a plain object as well as a Map', () => {
        const pa = new PrecomputedAnalysis({ 'src/a.js': analysis });
        expect(pa.size).toBe(1);
        expect(pa.getSymbols('', 'src/a.js')).toEqual(analysis.symbols);
    });
});

/**
 * Tests for findingsFlatten — canonical flat list + blocking count.
 */
const {
    flattenPerFileFindings,
    normalizeStaticFinding,
    buildCanonicalFindings,
    countBlocking
} = require('../../src/utils/findingsFlatten.js');

describe('findingsFlatten', () => {
    const perFile = [
        { file: 'src/a.py', language: 'python', findings: [
            { severity: 'high', line: 3, title: 'bug' },
            { severity: 'low', line: 9, title: 'nit', file: 'src/a.py' }
        ] },
        { file: 'src/b.js', language: 'javascript', findings: [
            { severity: 'critical', line: 1, title: 'sec' }
        ] }
    ];

    it('flattens nested findings and inherits file/language/source', () => {
        const flat = flattenPerFileFindings(perFile);
        expect(flat).toHaveLength(3);
        expect(flat[0]).toMatchObject({ file: 'src/a.py', language: 'python', source: 'llm' });
        expect(flat[2]).toMatchObject({ file: 'src/b.js', severity: 'critical' });
    });

    it('normalizes a static finding shape (filePath→file, ruleId→rule)', () => {
        const n = normalizeStaticFinding({ filePath: 'x.js', line: 5, severity: 'HIGH', ruleId: 'no-eval', message: 'eval' });
        expect(n.file).toBe('x.js');
        expect(n.severity).toBe('high');
        expect(n.rule).toBe('static/no-eval');
        expect(n.source).toBe('static');
    });

    it('builds a canonical list from both sources', () => {
        const canon = buildCanonicalFindings(perFile, [
            { filePath: 'x.js', line: 5, severity: 'medium', ruleId: 'no-eval', message: 'eval' }
        ]);
        expect(canon).toHaveLength(4);
        expect(canon.filter(f => f.source === 'static')).toHaveLength(1);
    });

    it('counts blocking (critical+high) findings only', () => {
        expect(countBlocking(flattenPerFileFindings(perFile))).toBe(2);
        expect(countBlocking([{ severity: 'low' }, { severity: 'medium' }])).toBe(0);
    });

    it('is null-safe on empty input', () => {
        expect(flattenPerFileFindings()).toEqual([]);
        expect(buildCanonicalFindings()).toEqual([]);
        expect(countBlocking()).toBe(0);
    });
});

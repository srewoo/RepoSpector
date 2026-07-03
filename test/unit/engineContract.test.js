/**
 * Tests for the shared engine→orchestrator contract (review-core).
 * Guarantees both the extension engine's per-file-object shape and the backend
 * engine's flat-findings shape normalize identically, so the two engines can't
 * drift apart.
 */

const { liftEngineFindings } = require('../../src/services/engineContract.js');

describe('liftEngineFindings', () => {
    it('should lift nested findings from per-file objects (MultiPassReviewEngine shape)', () => {
        const perFile = [
            {
                file: 'src/a.js',
                language: 'javascript',
                findings: [
                    { severity: 'high', line: 2, message: 'x' },
                    { severity: 'low', line: 9, message: 'y' },
                ],
            },
            { file: 'src/b.js', findings: [{ severity: 'medium', line: 1, message: 'z' }] },
        ];
        const out = liftEngineFindings(perFile);
        expect(out).toHaveLength(3);
        expect(out[0]).toMatchObject({ file: 'src/a.js', line: 2, severity: 'high' });
        expect(out[2]).toMatchObject({ file: 'src/b.js', line: 1, severity: 'medium' });
    });

    it('should inherit the parent file when a nested finding omits it', () => {
        const out = liftEngineFindings([
            { file: 'src/a.js', findings: [{ severity: 'high', line: 2, message: 'x' }] },
        ]);
        expect(out[0].file).toBe('src/a.js');
    });

    it('should let a nested finding override the parent file', () => {
        const out = liftEngineFindings([
            { file: 'src/a.js', findings: [{ file: 'src/other.js', line: 3, message: 'x' }] },
        ]);
        expect(out[0].file).toBe('src/other.js');
    });

    it('should pass through an already-flat findings array (BackendDeepEngine shape)', () => {
        const flat = [
            { severity: 'high', file: 'src/a.js', line: 2, message: 'x', source: 'llm' },
            { severity: 'low', file: 'src/b.js', line: 5, message: 'y', source: 'llm' },
        ];
        const out = liftEngineFindings(flat);
        expect(out).toEqual(flat);
    });

    it('should tolerate empty/undefined input and skip non-objects', () => {
        expect(liftEngineFindings(undefined)).toEqual([]);
        expect(liftEngineFindings([])).toEqual([]);
        expect(liftEngineFindings([null, 'nope', 42])).toEqual([]);
    });
});

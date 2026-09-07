const { summarizeGeneratedTests } = require('../../src/popup/components/generatedTestsPanelLogic.js');

const result = {
    files: [{ path: 'test/pay.test.js', targetFile: 'src/pay.js', mode: 'create', symbols: ['charge'], framework: 'jest', content: "it('x', () => {});", quality: { syntaxOk: true, score: 72, attempts: 1 } }],
    skipped: [{ file: 'src/util.js', reason: 'syntax: unexpected token' }],
    usage: { input: 1, output: 1 },
};

describe('summarizeGeneratedTests', () => {
    it('describes what to render for a normal result', () => {
        const s = summarizeGeneratedTests(result);
        expect(s).toMatchObject({ show: true, headline: '1 test file generated, 1 file skipped' });
        expect(s.files[0]).toMatchObject({ path: 'test/pay.test.js', modeLabel: 'new file', language: 'javascript' });
    });
    it('labels append mode', () => {
        const s = summarizeGeneratedTests({ files: [{ ...result.files[0], mode: 'append', path: 'test/a.test.py' }], skipped: [] });
        expect(s.files[0]).toMatchObject({ modeLabel: 'append to existing', language: 'python' });
        expect(s.headline).toBe('1 test file generated');
    });
    it('says nothing was generated when every file was skipped', () => {
        const s = summarizeGeneratedTests({ files: [], skipped: [{ file: null, reason: 'no untested exported symbols in this PR' }] });
        expect(s).toMatchObject({ show: true, headline: 'No tests generated, 1 file skipped' });
    });
    it('hides itself without a result', () => {
        expect(summarizeGeneratedTests(null)).toMatchObject({ show: false });
    });
    it('labels a null skipped file as "This PR", and a named file as itself', () => {
        const s = summarizeGeneratedTests({
            files: [],
            skipped: [
                { file: null, reason: 'no untested exported symbols in this PR' },
                { file: 'src/util.js', reason: 'syntax: unexpected token' },
            ],
        });
        expect(s.skipped[0]).toMatchObject({ file: null, label: 'This PR' });
        expect(s.skipped[1]).toMatchObject({ file: 'src/util.js', label: 'src/util.js' });
    });
    it('pluralizes both files and skipped entries when there are two of each', () => {
        const s = summarizeGeneratedTests({
            files: [
                { ...result.files[0], path: 'test/a.test.js' },
                { ...result.files[0], path: 'test/b.test.js' },
            ],
            skipped: [
                { file: 'src/a.js', reason: 'x' },
                { file: 'src/b.js', reason: 'y' },
            ],
        });
        expect(s.headline).toBe('2 test files generated, 2 files skipped');
    });
    it('pluralizes files generated with no skipped clause when there are two files and none skipped', () => {
        const s = summarizeGeneratedTests({
            files: [
                { ...result.files[0], path: 'test/a.test.js' },
                { ...result.files[0], path: 'test/b.test.js' },
            ],
            skipped: [],
        });
        expect(s.headline).toBe('2 test files generated');
    });
});

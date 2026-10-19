const { convertVerifiedFindings } = require('../../src/popup/utils/findingsParser.js');

describe('convertVerifiedFindings carries posting-relevant fields', () => {
    it('keeps rubric, permalink and lens', () => {
        const rubric = { status: 'unscored', reason: 'budget' };
        const [out] = convertVerifiedFindings([{
            file: 'a.js', line: 2, title: 't', rubric, permalink: 'https://x/y', lens: 'history',
        }]);
        expect(out.rubric).toEqual(rubric);
        expect(out.permalink).toBe('https://x/y');
        expect(out.lens).toBe('history');
    });

    it('defaults them to null', () => {
        const [out] = convertVerifiedFindings([{ file: 'a.js', line: 2, title: 't' }]);
        expect(out.rubric).toBeNull();
        expect(out.permalink).toBeNull();
        expect(out.lens).toBeNull();
    });
});

const {
    renderNotVerifiedSection,
    renderQualityNotes,
    renderDeferredSections,
} = require('../../src/utils/reviewSummarySections.js');

const SHA = 'b'.repeat(40);
const link = `https://github.com/acme/api/blob/${SHA}/src/a.js#L2-L4`;

describe('renderNotVerifiedSection', () => {
    it('is empty for nothing to say', () => {
        expect(renderNotVerifiedSection([])).toBe('');
    });

    it('lists each unscored finding with its reason and permalink', () => {
        const out = renderNotVerifiedSection([{
            file: 'src/a.js', line: 3, title: 'Possible race',
            permalink: link, rubric: { status: 'unscored', reason: 'call budget exhausted' },
        }]);
        expect(out).toContain('### Not verified');
        expect(out).toContain(`[\`src/a.js:3\`](${link})`);
        expect(out).toContain('_(call budget exhausted)_');
    });

    it('caps the list', () => {
        const many = Array.from({ length: 3 }, (_, i) => ({ file: 'a.js', line: i + 1, title: `t${i}`, rubric: { status: 'unscored' } }));
        const out = renderNotVerifiedSection(many, { maxItems: 2 });
        expect(out).toContain('…and 1 more');
    });
});

describe('renderQualityNotes', () => {
    it('renders config warnings and not-run checks, skipping lenses that ran', () => {
        const out = renderQualityNotes({
            configWarnings: ['unknown key `fooBar` in .repospector.yaml settings'],
            lensReport: [
                { lens: 'history', status: 'not-run', reason: 'no GitHub token' },
                { lens: 'codeComments', status: 'ok' },
            ],
        });
        expect(out).toContain('### Configuration warnings');
        expect(out).toContain('- unknown key `fooBar` in .repospector.yaml settings');
        expect(out).toContain('### Checks that did not run');
        expect(out).toContain('- `history` — no GitHub token');
        expect(out).not.toContain('codeComments');
    });

    it('flattens multi-line warnings and caps their length', () => {
        const out = renderQualityNotes({ configWarnings: [`a\nb${'x'.repeat(500)}`] });
        const line = out.split('\n').find((l) => l.startsWith('- a b'));
        expect(line).toBeDefined();
        expect(line.length).toBeLessThanOrEqual(202);
    });

    it('is empty when there is nothing to report', () => {
        expect(renderQualityNotes({})).toBe('');
    });
});

describe('summary bullets link permalinks', () => {
    it('links an https permalink and ignores anything else', () => {
        const good = renderDeferredSections([{ file: 'src/a.js', line: 3, title: 'T', permalink: link }], []);
        expect(good).toContain(`[\`src/a.js:3\`](${link})`);

        const bad = renderDeferredSections([{ file: 'src/a.js', line: 3, title: 'T', permalink: 'javascript:alert(1)' }], []);
        expect(bad).not.toContain('javascript:');
        expect(bad).toContain('`src/a.js:3`');
    });
});

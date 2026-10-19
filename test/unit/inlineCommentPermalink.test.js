const { buildCommentBody } = require('../../src/utils/inlineCommentFormatter.js');

const SHA = 'c'.repeat(40);
const link = `https://gitlab.example.com/grp/sub/proj/-/blob/${SHA}/src/a.js#L9-11`;
const base = { file: 'src/a.js', line: 10, severity: 'high', title: 'Null deref', source: 'llm' };

describe('buildCommentBody permalink', () => {
    it('renders a permalink line', () => {
        expect(buildCommentBody({ ...base, permalink: link }))
            .toContain(`🔗 [View the code at the reviewed commit](${link})`);
    });

    it('renders nothing for a missing or non-https permalink', () => {
        expect(buildCommentBody(base)).not.toContain('🔗');
        expect(buildCommentBody({ ...base, permalink: 'javascript:alert(1)' })).not.toContain('javascript:');
    });

    it('places the permalink before the provenance footer', () => {
        const body = buildCommentBody({ ...base, permalink: link });
        expect(body.indexOf('🔗')).toBeLessThan(body.indexOf('🛡️ RepoSpector'));
    });
});

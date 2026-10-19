const { permalinkHref } = require('../../src/popup/utils/permalink.js');

describe('permalinkHref', () => {
    it('returns an https permalink', () => {
        expect(permalinkHref({ permalink: 'https://x/y#L1' })).toBe('https://x/y#L1');
    });
    it.each([[{}], [null], [{ permalink: null }], [{ permalink: 'javascript:alert(1)' }], [{ permalink: 'http://x' }], [{ permalink: 42 }]])(
        'returns null for %j', (f) => expect(permalinkHref(f)).toBeNull(),
    );
});

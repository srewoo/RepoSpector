const { buildEnhancedTestPrompt } = require('../../src/utils/prompts.js');

describe('buildEnhancedTestPrompt graph callers', () => {
    it('renders call sites when the context has them', () => {
        const p = buildEnhancedTestPrompt('export function charge(a) {}', { testType: 'unit' }, {
            language: 'javascript', filePath: 'src/pay.js',
            graphCallers: [{ symbol: 'charge', callers: [{ name: 'checkout', filePath: 'src/checkout.js', line: 40 }] }],
        });
        expect(p).toMatch(/How production code calls/);
        expect(p).toMatch(/`charge` ← `checkout` \(src\/checkout\.js:40\)/);
    });
    it('renders nothing extra without them', () => {
        const p = buildEnhancedTestPrompt('x', { testType: 'unit' }, { language: 'javascript' });
        expect(p).not.toMatch(/How production code calls/);
    });
});

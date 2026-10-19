/**
 * M1: "rules text" for .repospector.yaml means ONE thing in every flow — the
 * rule entries, never the settings block — so the rubric's quoted-rule cap
 * behaves the same in the extension, MCP and eval.
 */
const { renderRepoRulesText } = require('../../src/review-core/repoRulesText.js');
const { collectRulesFiles } = require('../../src/services/reviewQualityStage.js');
const { rulesFilesForCase } = require('../../eval/lib/rubricReplay.js');

const CONFIG = {
    rules: [{ id: 'a', message: 'No console.log in src' }, { description: 'Prefer const' }, { pattern: 'eval\\(' }, 'Plain rule'],
    settings: { minRubricScore: 60, lensHistory: false },
};

describe('renderRepoRulesText', () => {
    it('renders rule entries as bullets and never the settings block', () => {
        const text = renderRepoRulesText(CONFIG);
        expect(text).toBe('- No console.log in src\n- Prefer const\n- eval\\(\n- Plain rule');
        expect(text).not.toMatch(/minRubricScore|lensHistory|settings/);
    });

    it('returns "" for no config, no rules, or a non-array rules value', () => {
        expect(renderRepoRulesText(null)).toBe('');
        expect(renderRepoRulesText({ settings: { minRubricScore: 60 } })).toBe('');
        expect(renderRepoRulesText({ rules: { message: 'x' } })).toBe('');
    });
});

describe('call sites use the shared renderer', () => {
    it('extension: collectRulesFiles', () => {
        const out = collectRulesFiles({ repoRules: CONFIG.rules });
        expect(out).toEqual([{ path: '.repospector.yaml', text: renderRepoRulesText(CONFIG) }]);
    });

    it('eval: rulesFilesForCase never quotes the settings block', () => {
        const files = rulesFilesForCase({
            fileContents: { '.repospector.yaml': 'settings:\n  minRubricScore: 60\n', 'CLAUDE.md': 'root' },
        });
        expect(files).toEqual([{ path: 'CLAUDE.md', text: 'root' }]);
    });
});

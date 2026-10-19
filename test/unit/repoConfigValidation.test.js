/**
 * `.repospector.yaml` settings validation (spec §4.1).
 *
 * `validateConfig` kept exactly four `settings` keys, so `lightModel`,
 * `multiFinder`, `llmRefutation` and every other documented key in a repo file
 * vanished without a word. These tests pin: every known key is kept with a type
 * check, everything dropped is reported, and a repo file can never supply a
 * credential.
 */
const { CustomRulesService } = require('../../src/services/CustomRulesService.js');
const { validateRepoSettings, REPO_SETTING_TYPES } = require('../../src/utils/repoSettingsSchema.js');
const {
    ENFORCEABLE_KEYS, USER_ONLY_KEYS, REVIEW_QUALITY_DEFAULTS, resolveConfig,
} = require('../../src/utils/configPrecedence.js');

const REVIEW_QUALITY_KEYS = [
    'minRubricScore', 'lightModel', 'verificationVotes', 'finderRounds', 'minConfidence',
    'lensHistory', 'lensCodeComments', 'lensRulesCompliance', 'lensPriorPrComments',
    'priorPrLimit', 'chunkConcurrency', 'valueScoring', 'hypothesisValidation',
    'repoExploration', 'explorationIterations', 'teamConventions',
];

describe('REPO_SETTING_TYPES', () => {
    it('covers every enforceable key and every review-quality key', () => {
        for (const k of [...ENFORCEABLE_KEYS, ...REVIEW_QUALITY_KEYS, 'model', 'diffAnchored']) {
            expect(REPO_SETTING_TYPES[k]).toBeDefined();
        }
    });
    it('never lists a user-only key', () => {
        for (const k of USER_ONLY_KEYS) expect(REPO_SETTING_TYPES[k]).toBeUndefined();
    });
});

describe('validateRepoSettings', () => {
    it('keeps valid keys, normalised', () => {
        const { settings, warnings } = validateRepoSettings({
            multiFinder: false, llmRefutation: true, lightModel: ' openai:gpt-4.1-mini ',
            minRubricScore: 90, priorPrLimit: 3, chunkConcurrency: 8, minConfidence: 0.7,
            severityThreshold: 'HIGH', failLevel: 'none', filterMode: 'diff_context',
            lensHistory: 'no', valueScoring: 'yes',
        });
        expect(warnings).toEqual([]);
        expect(settings).toEqual({
            multiFinder: false, llmRefutation: true, lightModel: 'openai:gpt-4.1-mini',
            minRubricScore: 90, priorPrLimit: 3, chunkConcurrency: 8, minConfidence: 0.7,
            severityThreshold: 'high', failLevel: 'none', filterMode: 'diff_context',
            lensHistory: false, valueScoring: true,
        });
    });

    it.each([
        ['minRubricScore', 150, /integer 0-100/],
        ['minRubricScore', 'high', /integer 0-100/],
        ['minRubricScore', 80.5, /integer 0-100/],
        ['priorPrLimit', 0, /integer 1-20/],
        ['chunkConcurrency', 9, /integer 1-8/],
        ['minConfidence', 80, /number 0-1/],
        ['multiFinder', 'maybe', /true or false/],
        ['failLevel', 'sometimes', /one of none, any/],
        ['filterMode', 'bogus', /one of added/],
        ['lightModel', '', /non-empty/],
    ])('drops %s=%p with a warning', (key, value, why) => {
        const { settings, warnings } = validateRepoSettings({ [key]: value });
        expect(settings[key]).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`\`${key}\``);
        expect(warnings[0]).toMatch(why);
    });

    it('reports unknown keys', () => {
        const { settings, warnings } = validateRepoSettings({ minRubricScroe: 70 });
        expect(settings).toEqual({});
        expect(warnings[0]).toMatch(/Unknown setting `minRubricScroe`/);
    });

    it.each(USER_ONLY_KEYS)('always rejects the user-only key %s', (key) => {
        const { settings, warnings } = validateRepoSettings({ [key]: 'attacker-value' });
        expect(settings[key]).toBeUndefined();
        expect(warnings[0]).toMatch(new RegExp(`\`${key}\` is only read from your own Settings`));
    });

    it('warns when settings is not a mapping', () => {
        expect(validateRepoSettings('fast').warnings[0]).toMatch(/must be a mapping/);
        expect(validateRepoSettings(['a']).warnings[0]).toMatch(/must be a mapping/);
    });

    it('absent settings is no settings and no warnings', () => {
        expect(validateRepoSettings(undefined)).toEqual({ settings: {}, warnings: [] });
    });
});

describe('CustomRulesService.validateConfig', () => {
    const svc = new CustomRulesService();

    it('returns configWarnings and the full validated settings', () => {
        const cfg = svc.validateConfig({
            settings: { lightModel: 'openai:gpt-4.1-mini', multiFinder: false, apiKey: 'sk-evil', bogus: 1 },
        });
        expect(cfg.settings).toEqual({ lightModel: 'openai:gpt-4.1-mini', multiFinder: false, diffAnchored: true });
        expect(cfg.settings.apiKey).toBeUndefined();
        expect(cfg.configWarnings).toHaveLength(2);
        expect(cfg.configWarnings.join('\n')).toMatch(/apiKey/);
        expect(cfg.configWarnings.join('\n')).toMatch(/bogus/);
    });

    it('absent keys stay absent so they cannot override the user layer with null', () => {
        const cfg = svc.validateConfig({ settings: {} });
        expect('minConfidence' in cfg.settings).toBe(false);
        expect('model' in cfg.settings).toBe(false);
        const { config } = resolveConfig({ user: { minConfidence: 0.6 }, repo: cfg.settings });
        expect(config.minConfidence).toBe(0.6);
    });

    it('parses a real YAML file end to end', () => {
        const yaml = [
            'settings:',
            '  minRubricScore: 70',
            '  lensPriorPrComments: false',
            '  priorPrLimit: 50',
            '  githubToken: ghp_x',
            'rules:',
            '  - id: no-console',
        ].join('\n');
        const cfg = svc.validateConfig(svc.parseYAML(yaml));
        expect(cfg.settings.minRubricScore).toBe(70);
        expect(cfg.settings.lensPriorPrComments).toBe(false);
        expect(cfg.settings.priorPrLimit).toBeUndefined();
        expect(cfg.settings.githubToken).toBeUndefined();
        expect(cfg.configWarnings).toHaveLength(2);
    });
});

describe('REVIEW_QUALITY_DEFAULTS', () => {
    it('matches the spec defaults', () => {
        expect(REVIEW_QUALITY_DEFAULTS).toEqual({
            minRubricScore: 80, lensHistory: true, lensCodeComments: true, lensRulesCompliance: true,
            lensPriorPrComments: true, priorPrLimit: 5, chunkConcurrency: 3, valueScoring: false,
        });
    });
    it('is the lowest layer: user and repo override it', () => {
        const { config, provenance } = resolveConfig({
            defaults: REVIEW_QUALITY_DEFAULTS,
            user: { minRubricScore: 60 },
            repo: { lensHistory: false },
        });
        expect(config.minRubricScore).toBe(60);
        expect(config.lensHistory).toBe(false);
        expect(config.priorPrLimit).toBe(5);
        expect(provenance.priorPrLimit).toBe('defaults');
    });
});

const { CustomRulesService } = require('../../src/services/CustomRulesService.js');

describe('CustomRulesService — severity threshold + model pin', () => {
    let svc;
    beforeEach(() => { svc = new CustomRulesService(); });

    describe('validateConfig', () => {
        it('exposes settings.model and settings.diffAnchored', () => {
            const cfg = svc.validateConfig({
                settings: {
                    severityThreshold: 'high',
                    model: 'openai:gpt-4.1-mini',
                    diffAnchored: false,
                },
            });
            expect(cfg.settings.severityThreshold).toBe('high');
            expect(cfg.settings.model).toBe('openai:gpt-4.1-mini');
            expect(cfg.settings.diffAnchored).toBe(false);
        });

        it('defaults diffAnchored to true', () => {
            const cfg = svc.validateConfig({});
            expect(cfg.settings.diffAnchored).toBe(true);
        });
    });

    describe('applySeverityThreshold', () => {
        const findings = [
            { ruleId: 'a', severity: 'info' },
            { ruleId: 'b', severity: 'low' },
            { ruleId: 'c', severity: 'medium' },
            { ruleId: 'd', severity: 'high' },
            { ruleId: 'e', severity: 'critical' },
        ];

        it('returns input unchanged when threshold is unset', () => {
            const out = svc.applySeverityThreshold(findings, { settings: {} });
            expect(out).toHaveLength(5);
        });

        it('drops findings below the threshold', () => {
            const out = svc.applySeverityThreshold(findings, {
                settings: { severityThreshold: 'high' },
            });
            expect(out.map((f) => f.ruleId)).toEqual(['d', 'e']);
        });

        it('treats unknown threshold as no filter', () => {
            const out = svc.applySeverityThreshold(findings, {
                settings: { severityThreshold: 'banana' },
            });
            expect(out).toHaveLength(5);
        });

        it('treats missing severity as info (lowest)', () => {
            const f = [{ ruleId: 'x' }, { ruleId: 'y', severity: 'high' }];
            const out = svc.applySeverityThreshold(f, {
                settings: { severityThreshold: 'medium' },
            });
            expect(out.map((r) => r.ruleId)).toEqual(['y']);
        });
    });

    describe('applyAllRules wires the threshold in', () => {
        it('drops below-threshold findings end-to-end', () => {
            const out = svc.applyAllRules(
                [
                    { ruleId: 'a', severity: 'low', confidence: 0.9 },
                    { ruleId: 'b', severity: 'critical', confidence: 0.9 },
                ],
                {
                    ignore: { files: [], rules: [] },
                    severity_overrides: {},
                    rules: [],
                    settings: { severityThreshold: 'high' },
                }
            );
            expect(out.map((f) => f.ruleId)).toEqual(['b']);
        });
    });
});

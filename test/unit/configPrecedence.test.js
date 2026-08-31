/**
 * The precedence chain's value is that it is checkable. Two properties matter
 * most: an org's pinned key cannot be moved by a repo (or the tier is
 * decoration), and a `.repospector.yaml` — attacker-controlled content on any
 * public repo — can never supply a credential.
 */

const {
    resolveConfig,
    flag,
    explainOverrides,
    LAYERS,
    ENFORCEABLE_KEYS,
} = require('../../src/utils/configPrecedence.js');

describe('resolveConfig ordering', () => {
    it('applies layers lowest to highest', () => {
        const { config, provenance } = resolveConfig({
            defaults: { severityThreshold: 'medium', autofix: true },
            user: { severityThreshold: 'low' },
            org: { severityThreshold: 'high' },
            repo: { severityThreshold: 'critical' },
            call: { severityThreshold: 'all' },
        });
        expect(config.severityThreshold).toBe('all');
        expect(provenance.severityThreshold).toBe('call');
        // Untouched keys keep their default and say so.
        expect(config.autofix).toBe(true);
        expect(provenance.autofix).toBe('defaults');
    });

    it('puts a repo config above the user settings', () => {
        // A committed .repospector.yaml is a team decision; Settings is one
        // person's machine. This is existing behaviour and must not regress.
        const { config, provenance } = resolveConfig({
            user: { multiFinder: false },
            repo: { multiFinder: true },
        });
        expect(config.multiFinder).toBe(true);
        expect(provenance.multiFinder).toBe('repo');
    });

    it('treats undefined as silence, not as an instruction', () => {
        const { config, provenance } = resolveConfig({
            user: { verifyFindings: true },
            call: { verifyFindings: undefined },
        });
        expect(config.verifyFindings).toBe(true);
        expect(provenance.verifyFindings).toBe('user');
    });

    it('lets a higher layer turn something back ON', () => {
        // The old `a !== false && b !== false` idiom made this impossible: any
        // layer could veto, none could restore.
        const { config } = resolveConfig({
            user: { graphContext: false },
            call: { graphContext: true },
        });
        expect(config.graphContext).toBe(true);
    });

    it('ignores a missing or non-object layer', () => {
        const { config } = resolveConfig({ user: null, repo: undefined, call: 'nope' });
        expect(config).toEqual({});
        expect(resolveConfig().config).toEqual({});
    });

    it('exposes the layer order it documents', () => {
        expect(LAYERS).toEqual(['defaults', 'user', 'org', 'repo', 'call']);
    });
});

describe('organization enforcement', () => {
    it('pins a key so a repo cannot override it', () => {
        const res = resolveConfig({
            user: { enablePostInlineComments: false },
            org: { enablePostInlineComments: true, enforce: ['enablePostInlineComments'] },
            repo: { enablePostInlineComments: false },
        });
        expect(res.config.enablePostInlineComments).toBe(true);
        expect(res.provenance.enablePostInlineComments).toBe('org (enforced)');
        expect(res.enforced).toContain('enablePostInlineComments');
        expect(res.rejected).toEqual([
            expect.objectContaining({ key: 'enablePostInlineComments', layer: 'repo' }),
        ]);
    });

    it('pins against a per-call override too', () => {
        const res = resolveConfig({
            org: { verifyFindings: true, enforce: ['verifyFindings'] },
            call: { verifyFindings: false },
        });
        expect(res.config.verifyFindings).toBe(true);
    });

    it('leaves un-enforced org keys overridable', () => {
        const res = resolveConfig({
            org: { autofix: true, enforce: ['verifyFindings'] },
            repo: { autofix: false },
        });
        expect(res.config.autofix).toBe(false);
        expect(res.enforced).toEqual([]);
    });

    it('refuses to pin a key outside the enforceable list, and says so', () => {
        // An org that believes it locked something it did not is worse than an
        // org that was told no.
        const res = resolveConfig({
            user: { model: 'openai:gpt-4.1' },
            org: { model: 'openai:gpt-3.5-turbo', enforce: ['model'] },
            repo: { model: 'anthropic:claude-3.5-sonnet' },
        });
        expect(res.config.model).toBe('anthropic:claude-3.5-sonnet');
        expect(res.rejected).toEqual([
            expect.objectContaining({ key: 'model', layer: 'org', reason: 'not an enforceable key' }),
        ]);
    });

    it('never lets an org pin a credential or a cost knob', () => {
        for (const key of ['apiKey', 'githubToken', 'maxAiCalls']) {
            expect(ENFORCEABLE_KEYS).not.toContain(key);
        }
    });

    it('survives a malformed enforce field', () => {
        expect(() => resolveConfig({ org: { enforce: 'enablePostInlineComments' } })).not.toThrow();
        expect(resolveConfig({ org: { enforce: 'x', autofix: true } }).config.autofix).toBe(true);
    });

    it('does not leak `enforce` into the resolved config', () => {
        const res = resolveConfig({ org: { enforce: ['autofix'], autofix: true } });
        expect(res.config.enforce).toBeUndefined();
    });
});

describe('credentials', () => {
    it('refuses a token from a repo config', () => {
        // .repospector.yaml is attacker-controlled content on any public repo.
        const res = resolveConfig({
            user: { githubToken: 'real' },
            repo: { githubToken: 'ghp_attacker', gitlabHosts: 'evil.example.com' },
        });
        expect(res.config.githubToken).toBe('real');
        expect(res.config.gitlabHosts).toBeUndefined();
        expect(res.rejected.map(r => r.key).sort()).toEqual(['githubToken', 'gitlabHosts']);
        expect(res.rejected[0].reason).toMatch(/only from Settings/);
    });

    it('refuses one from an org policy too', () => {
        const res = resolveConfig({ user: { apiKey: 'mine' }, org: { apiKey: 'theirs' } });
        expect(res.config.apiKey).toBe('mine');
    });

    it('still allows a repo to pin the model', () => {
        // Existing, wanted feature: spends the user's own key on their own provider.
        const res = resolveConfig({
            user: { model: 'openai:gpt-4.1-mini' },
            repo: { model: 'openai:gpt-4.1' },
        });
        expect(res.config.model).toBe('openai:gpt-4.1');
    });
});

describe('flag', () => {
    it('defaults to on when unset', () => {
        expect(flag({}, 'autofix')).toBe(true);
        expect(flag({ autofix: undefined }, 'autofix')).toBe(true);
        expect(flag(null, 'autofix')).toBe(true);
    });

    it('honours an explicit default', () => {
        expect(flag({}, 'llmRefutation', false)).toBe(false);
    });

    it('reads booleans', () => {
        expect(flag({ autofix: false }, 'autofix')).toBe(false);
        expect(flag({ autofix: true }, 'autofix')).toBe(true);
    });

    it("reads YAML's spellings, since the file is hand-written", () => {
        for (const off of ['false', 'off', 'no', '0', ' OFF ']) {
            expect(flag({ autofix: off }, 'autofix')).toBe(false);
        }
        for (const on of ['true', 'on', 'yes', '1']) {
            expect(flag({ autofix: on }, 'autofix')).toBe(true);
        }
    });

    it('treats null as unset rather than as false', () => {
        expect(flag({ autofix: null }, 'autofix')).toBe(true);
    });
});

describe('explainOverrides', () => {
    it('produces one line per refused value', () => {
        const res = resolveConfig({
            org: { verifyFindings: true, enforce: ['verifyFindings'] },
            repo: { verifyFindings: false, githubToken: 'x' },
        });
        const lines = explainOverrides(res);
        expect(lines).toHaveLength(2);
        expect(lines.join('\n')).toContain('enforced by organization policy');
        expect(lines.join('\n')).toContain('only from Settings');
    });

    it('is empty when nothing was refused', () => {
        expect(explainOverrides(resolveConfig({ user: { autofix: true } }))).toEqual([]);
        expect(explainOverrides(null)).toEqual([]);
    });
});

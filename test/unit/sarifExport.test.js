/**
 * The SARIF we emit is consumed by GitHub code scanning, which means two
 * properties matter more than anything about formatting:
 *
 *   - `partialFingerprints` decides whether an alert is "the same" across runs.
 *     Derive it from the line number and every re-review resurrects every
 *     dismissed alert, which teaches people to ignore the feed.
 *   - `automationDetails.id` keeps our run from clearing the repo's CodeQL
 *     alerts.
 *
 * The rest of these tests are about not misattributing a relayed finding to us.
 */

const { buildSarif, toSarifJson, fingerprint } = require('../../src/utils/sarifExport.js');

const finding = (over = {}) => ({
    ruleId: 'repospector/nullable-deref',
    filePath: 'src/users.js',
    line: 42,
    severity: 'high',
    type: 'bug',
    title: 'Possible null dereference',
    description: 'row may be null when the query misses.',
    suggestion: 'Guard with `if (!row) return null;`',
    evidence: 'return row.name;',
    confidence: 0.9,
    source: 'llm',
    ...over,
});

describe('buildSarif structure', () => {
    it('emits a valid-shaped 2.1.0 log', () => {
        const log = buildSarif([finding()], { version: '1.2.3', model: 'openai:gpt-4.1' });

        expect(log.version).toBe('2.1.0');
        expect(log.$schema).toMatch(/sarif-schema-2\.1\.0/);
        expect(log.runs).toHaveLength(1);
        expect(log.runs[0].tool.driver.name).toBe('RepoSpector');
        expect(log.runs[0].tool.driver.version).toBe('1.2.3');
        expect(log.runs[0].results).toHaveLength(1);
    });

    it('sets automationDetails so it cannot clobber another tool\'s alerts', () => {
        // Without this, uploading a RepoSpector run clears the repo's CodeQL alerts.
        expect(buildSarif([finding()]).runs[0].automationDetails.id).toBe('repospector/review');
    });

    it('links each result to its rule by index and id', () => {
        const log = buildSarif([
            finding(),
            finding({ ruleId: 'repospector/other', title: 'Other' }),
            finding({ line: 90 }),   // same rule as the first
        ]);

        expect(log.runs[0].tool.driver.rules).toHaveLength(2);
        const results = log.runs[0].results;
        expect(results[0].ruleIndex).toBe(0);
        expect(results[1].ruleIndex).toBe(1);
        expect(results[2].ruleIndex).toBe(0);
        expect(results[0].ruleId).toBe('repospector/nullable-deref');
    });

    it('maps severity to level and a security score', () => {
        const at = (sev) => {
            const log = buildSarif([finding({ severity: sev })]);
            return [log.runs[0].results[0].level, log.runs[0].tool.driver.rules[0].properties['security-severity']];
        };
        expect(at('critical')).toEqual(['error', '9.5']);
        expect(at('high')).toEqual(['error', '7.5']);
        expect(at('medium')).toEqual(['warning', '5.0']);
        expect(at('low')).toEqual(['note', '3.0']);
        expect(at('nonsense')).toEqual(['warning', '5.0']);
    });

    it('records the location, region and snippet', () => {
        const loc = buildSarif([finding({ endLine: 44 })]).runs[0].results[0].locations[0].physicalLocation;
        expect(loc.artifactLocation.uri).toBe('src/users.js');
        expect(loc.region).toMatchObject({ startLine: 42, endLine: 44 });
        expect(loc.region.snippet.text).toBe('return row.name;');
    });

    it('omits region for a file-level finding rather than inventing line 0', () => {
        // SARIF cannot express "about the file"; no region IS the expression.
        const loc = buildSarif([finding({ line: null })]).runs[0].results[0].locations[0].physicalLocation;
        expect(loc.region).toBeUndefined();
        expect(loc.artifactLocation.uri).toBe('src/users.js');
    });

    it('ignores an endLine that precedes the start', () => {
        const region = buildSarif([finding({ endLine: 3 })]).runs[0].results[0].locations[0].physicalLocation.region;
        expect(region.endLine).toBeUndefined();
    });

    it('normalises paths', () => {
        const uri = (p) => buildSarif([finding({ filePath: p })]).runs[0].results[0]
            .locations[0].physicalLocation.artifactLocation.uri;
        expect(uri('./src/a.js')).toBe('src/a.js');
        expect(uri('src\\a.js')).toBe('src/a.js');
        expect(uri('/src/a.js')).toBe('src/a.js');
    });

    it('drops a finding with no file at all', () => {
        // There is nowhere to put it, and a result with no location is rejected.
        const log = buildSarif([finding(), { title: 'orphan', severity: 'high' }]);
        expect(log.runs[0].results).toHaveLength(1);
    });

    it('carries the commit and repo when given', () => {
        const log = buildSarif([finding()], {
            prUrl: 'https://github.com/acme/widgets/pull/7',
            commitSha: 'deadbeef',
        });
        expect(log.runs[0].versionControlProvenance[0]).toEqual({
            repositoryUri: 'https://github.com/acme/widgets',
            revisionId: 'deadbeef',
        });
    });

    it('handles a GitLab MR URL, including subgroups', () => {
        // A fixed host/one/two pattern silently failed on subgroups, which this
        // repo supports everywhere else.
        const log = buildSarif([finding()], {
            prUrl: 'https://gitlab.com/group/sub/proj/-/merge_requests/3',
            commitSha: 'cafe',
        });
        expect(log.runs[0].versionControlProvenance[0].repositoryUri)
            .toBe('https://gitlab.com/group/sub/proj');
    });

    it('handles a self-hosted GitLab URL', () => {
        const log = buildSarif([finding()], {
            prUrl: 'https://gitlab.internal.example.com/a/b/-/merge_requests/9',
            commitSha: 'x',
        });
        expect(log.runs[0].versionControlProvenance[0].repositoryUri)
            .toBe('https://gitlab.internal.example.com/a/b');
    });

    it('handles an empty finding set', () => {
        const log = buildSarif([]);
        expect(log.runs[0].results).toEqual([]);
        expect(log.runs[0].tool.driver.rules).toEqual([]);
    });
});

describe('fingerprints', () => {
    it('are stable for the same finding', () => {
        expect(fingerprint(finding())).toBe(fingerprint(finding()));
    });

    it('do NOT change when the code moves', () => {
        // The single most important property here: an alert that reappears because
        // someone added an import above it is noise, and noise kills the feed.
        expect(fingerprint(finding({ line: 42 }))).toBe(fingerprint(finding({ line: 400 })));
    });

    it('do not change on reindentation', () => {
        const a = finding({ evidence: 'return row.name;' });
        const b = finding({ evidence: '        return   row.name;' });
        expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('DO change for a different rule, file, or code', () => {
        const base = fingerprint(finding());
        expect(fingerprint(finding({ ruleId: 'other' }))).not.toBe(base);
        expect(fingerprint(finding({ filePath: 'src/other.js' }))).not.toBe(base);
        expect(fingerprint(finding({ evidence: 'return row.email;' }))).not.toBe(base);
    });

    it('are 16 hex chars', () => {
        expect(fingerprint(finding())).toMatch(/^[0-9a-f]{16}$/);
    });

    it('survive a finding with almost nothing in it', () => {
        expect(fingerprint({})).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('provenance in the alert', () => {
    it('tags a deterministic finding differently from a model one', () => {
        // The distinction a triager needs first.
        const det = buildSarif([finding({ deterministic: true })]);
        expect(det.runs[0].tool.driver.rules[0].properties.tags).toContain('deterministic');

        const llm = buildSarif([finding()]);
        expect(llm.runs[0].tool.driver.rules[0].properties.tags).toContain('ai-generated');
    });

    it('keeps a relayed finding attributed to the tool that found it', () => {
        // Otherwise a CodeQL finding uploaded by us reads as ours.
        const log = buildSarif([finding({
            source: 'external',
            attribution: 'Reported by CodeQL',
            ruleUrl: 'https://codeql.github.com/help/x',
            ruleId: 'js/sql-injection',
        })]);

        expect(log.runs[0].results[0].message.text).toContain('Reported by CodeQL');
        expect(log.runs[0].tool.driver.rules[0].helpUri).toBe('https://codeql.github.com/help/x');
        expect(log.runs[0].tool.driver.rules[0].properties.tags).toContain('relayed');
    });

    it('puts the suggested fix in the alert message', () => {
        const text = buildSarif([finding()]).runs[0].results[0].message.text;
        expect(text).toContain('Suggested fix:');
        expect(text).toContain('if (!row) return null;');
    });

    it('records a CWE as a SARIF tag', () => {
        const tags = buildSarif([finding({ cwe: 'CWE-89' })]).runs[0].tool.driver.rules[0].properties.tags;
        expect(tags).toContain('external/cwe/cwe-89');
    });

    it('notes when a finding was relocated', () => {
        const props = buildSarif([finding({ relocated: { from: 45, to: 42, distance: 3 } })])
            .runs[0].results[0].properties;
        expect(props.relocatedFrom).toBe(45);
    });
});

describe('toSarifJson', () => {
    it('produces parseable JSON ending in a newline', () => {
        const json = toSarifJson([finding()], { version: '1.0.0' });
        expect(json.endsWith('\n')).toBe(true);
        expect(() => JSON.parse(json)).not.toThrow();
        expect(JSON.parse(json).version).toBe('2.1.0');
    });

    it('round-trips through our own SARIF parser', () => {
        // The clearest end-to-end check available: what we emit, we can read.
        const { parseSarif } = require('../../src/utils/externalFindings.js');
        const json = toSarifJson([finding({ cwe: 'CWE-476' })]);
        const { findings } = parseSarif(JSON.parse(json));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            ruleId: 'repospector/nullable-deref',
            filePath: 'src/users.js',
            line: 42,
            severity: 'high',
            cwe: 'CWE-476',
            tool: 'RepoSpector',
        });
    });
});

/**
 * This branch unified the severity vocabulary on `blocking`/`suggestion`/
 * `nitpick`. SARIF understood only the legacy names, so a canonical blocking
 * finding exported through the `|| 'warning'` / `|| '5.0'` fallbacks and
 * understated itself in a security dashboard.
 */
describe('canonical severity vocabulary', () => {
    const levelOf = (severity) => buildSarif([finding({ severity })], {}).runs[0].results[0].level;
    const scoreOf = (severity) => {
        const log = buildSarif([finding({ severity })], {});
        const rule = log.runs[0].tool.driver.rules.find(r => r.id === 'repospector/nullable-deref');
        return rule.properties['security-severity'];
    };

    it('blocking is an error, not a warning', () => {
        expect(levelOf('blocking')).toBe('error');
        expect(scoreOf('blocking')).toBe('9.0');
    });

    it('suggestion and nitpick map to warning and note', () => {
        expect(levelOf('suggestion')).toBe('warning');
        expect(levelOf('nitpick')).toBe('note');
    });

    it('provider-path aliases resolve too', () => {
        expect(levelOf('blocker')).toBe('error');
        expect(levelOf('error')).toBe('error');
    });

    it('the legacy vocabulary is unchanged', () => {
        expect(levelOf('critical')).toBe('error');
        expect(levelOf('high')).toBe('error');
        expect(levelOf('medium')).toBe('warning');
        expect(levelOf('low')).toBe('note');
    });
});

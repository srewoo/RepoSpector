/**
 * A SARIF file arrives from a CI job configured by the repo, which on a public
 * repo means attacker-controlled content. Roughly half of these tests are about
 * that: paths that escape the repo, `javascript:` help URLs, unbounded counts.
 * The other half is that real scanner output parses correctly — severity from
 * `security-severity` rather than everything-is-a-warning, rule metadata reached
 * by index as well as by id, and the doc URL that makes a finding checkable.
 */

const {
    detectFormat,
    parseReport,
    parseSarif,
    parseRdjson,
    toReviewFindings,
    normalizePath,
    safeUrl,
    FORMAT,
    LIMITS,
} = require('../../src/utils/externalFindings.js');

/** A CodeQL-shaped SARIF log. */
const SARIF = {
    version: '2.1.0',
    runs: [{
        tool: {
            driver: {
                name: 'CodeQL',
                rules: [{
                    id: 'js/sql-injection',
                    shortDescription: { text: 'Database query built from user input' },
                    fullDescription: { text: 'Building a SQL query from user-controlled sources.' },
                    helpUri: 'https://codeql.github.com/codeql-query-help/javascript/js-sql-injection/',
                    properties: { tags: ['security', 'external/cwe/cwe-089'], 'security-severity': '8.8' },
                }],
            },
        },
        results: [{
            ruleId: 'js/sql-injection',
            level: 'warning',
            message: { text: 'This query depends on a user-provided value.' },
            locations: [{
                physicalLocation: {
                    artifactLocation: { uri: 'src/db/users.js' },
                    region: { startLine: 42, endLine: 44, startColumn: 9, snippet: { text: 'db.query(`...`)' } },
                },
            }],
            partialFingerprints: { primaryLocationLineHash: 'abc123' },
        }],
    }],
};

describe('detectFormat', () => {
    it('recognises SARIF, rdjson and rdjsonl', () => {
        expect(detectFormat(SARIF)).toBe(FORMAT.SARIF);
        expect(detectFormat(JSON.stringify(SARIF))).toBe(FORMAT.SARIF);
        expect(detectFormat({ diagnostics: [] })).toBe(FORMAT.RDJSON);
        expect(detectFormat('{"message":"x","location":{"path":"a.js"}}\n{"message":"y"}'))
            .toBe(FORMAT.RDJSONL);
    });

    it('returns unknown rather than guessing', () => {
        for (const junk of ['', null, undefined, 'hello', '{}', '[]', '<?xml version="1.0"?>']) {
            expect(detectFormat(junk)).toBe(FORMAT.UNKNOWN);
        }
    });
});

describe('normalizePath', () => {
    it('keeps a repo-relative path', () => {
        expect(normalizePath('src/db/users.js')).toBe('src/db/users.js');
        expect(normalizePath('./src/a.js')).toBe('src/a.js');
        expect(normalizePath('src%2Fa.js')).toBe('src/a.js');
        expect(normalizePath('src\\a.js')).toBe('src/a.js');
    });

    it('rejects traversal and absolute paths', () => {
        // A finding on a path outside the repo can never match the diff, so
        // rejecting it costs nothing and closes the door on misdirection.
        for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/../../b', '/home/runner/work/x.js']) {
            expect(normalizePath(bad)).toBeNull();
        }
    });

    it('accepts a file: URI but no other scheme', () => {
        expect(normalizePath('file:src/a.js')).toBe('src/a.js');
        expect(normalizePath('https://evil.example.com/a.js')).toBeNull();
        expect(normalizePath('javascript:alert(1)')).toBeNull();
    });

    it('rejects an absurdly long path', () => {
        expect(normalizePath('a/'.repeat(500))).toBeNull();
    });

    it('rejects junk', () => {
        for (const bad of ['', null, undefined, 42, {}, '   ']) {
            expect(normalizePath(bad)).toBeNull();
        }
    });
});

describe('safeUrl', () => {
    it('keeps http(s) only', () => {
        expect(safeUrl('https://example.com/rule')).toBe('https://example.com/rule');
        expect(safeUrl('http://example.com')).toBe('http://example.com');
    });

    it('rejects anything that could execute or embed', () => {
        // This URL is rendered as a link in the panel; the report is untrusted.
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'vbscript:x']) {
            expect(safeUrl(bad)).toBeNull();
        }
    });

    it('rejects junk and overlong values', () => {
        expect(safeUrl(null)).toBeNull();
        expect(safeUrl('')).toBeNull();
        expect(safeUrl(`https://example.com/${'a'.repeat(600)}`)).toBeNull();
    });
});

describe('parseSarif', () => {
    it('extracts the finding with its rule documentation URL', () => {
        const { findings } = parseSarif(SARIF);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            ruleId: 'js/sql-injection',
            filePath: 'src/db/users.js',
            line: 42,
            endLine: 44,
            column: 9,
            category: 'security',
            cwe: 'CWE-89',
            tool: 'CodeQL',
            fingerprint: 'abc123',
        });
        // The credibility payload: a reviewer can check the claim.
        expect(findings[0].ruleUrl).toMatch(/^https:\/\/codeql\.github\.com/);
        expect(findings[0].ruleDescription).toMatch(/user-controlled sources/);
    });

    it('prefers security-severity over level', () => {
        // Most tools leave `level` at "warning" for everything, so the CVSS-style
        // score is the only usable signal.
        const { findings } = parseSarif(SARIF);
        expect(findings[0].severity).toBe('high'); // 8.8, not "warning" → medium
    });

    it('maps the CVSS bands', () => {
        const at = (score) => {
            const s = JSON.parse(JSON.stringify(SARIF));
            s.runs[0].tool.driver.rules[0].properties['security-severity'] = score;
            return parseSarif(s).findings[0].severity;
        };
        expect(at('9.5')).toBe('critical');
        expect(at('7.0')).toBe('high');
        expect(at('4.0')).toBe('medium');
        expect(at('1.0')).toBe('low');
    });

    it('falls back to level when there is no score', () => {
        const s = JSON.parse(JSON.stringify(SARIF));
        delete s.runs[0].tool.driver.rules[0].properties['security-severity'];
        expect(parseSarif(s).findings[0].severity).toBe('medium'); // warning
    });

    it('resolves rule metadata by ruleIndex as well as by id', () => {
        // Both forms are in the wild; golangci-lint emits index-only results.
        const s = {
            runs: [{
                tool: { driver: { name: 'tool', rules: [{ id: 'R1', helpUri: 'https://x.test/r1' }] } },
                results: [{
                    ruleIndex: 0,
                    message: { text: 'problem' },
                    locations: [{ physicalLocation: { artifactLocation: { uri: 'a.js' }, region: { startLine: 1 } } }],
                }],
            }],
        };
        const { findings } = parseSarif(s);
        expect(findings[0].ruleId).toBe('R1');
        expect(findings[0].ruleUrl).toBe('https://x.test/r1');
    });

    it('reads rules from tool extensions too', () => {
        const s = {
            runs: [{
                tool: {
                    driver: { name: 'tool' },
                    extensions: [{ rules: [{ id: 'E1', helpUri: 'https://x.test/e1' }] }],
                },
                results: [{
                    ruleId: 'E1',
                    message: { text: 'problem' },
                    locations: [{ physicalLocation: { artifactLocation: { uri: 'a.js' }, region: { startLine: 1 } } }],
                }],
            }],
        };
        expect(parseSarif(s).findings[0].ruleUrl).toBe('https://x.test/e1');
    });

    it('keeps a result with no line as a file-level finding', () => {
        // "This file's new dependency is vulnerable" is a legitimate statement.
        const s = {
            runs: [{
                tool: { driver: { name: 'trivy' } },
                results: [{
                    ruleId: 'CVE-2024-1',
                    message: { text: 'vulnerable dependency' },
                    locations: [{ physicalLocation: { artifactLocation: { uri: 'package-lock.json' } } }],
                }],
            }],
        };
        const { findings } = parseSarif(s);
        expect(findings).toHaveLength(1);
        expect(findings[0].line).toBeNull();
    });

    it('drops a result whose path escapes the repo', () => {
        const s = JSON.parse(JSON.stringify(SARIF));
        s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = '../../etc/passwd';
        const { findings, stats } = parseSarif(s);
        expect(findings).toHaveLength(0);
        expect(stats.dropped).toBe(1);
    });

    it('drops a hostile helpUri without dropping the finding', () => {
        const s = JSON.parse(JSON.stringify(SARIF));
        s.runs[0].tool.driver.rules[0].helpUri = 'javascript:alert(document.cookie)';
        const { findings } = parseSarif(s);
        expect(findings).toHaveLength(1);
        expect(findings[0].ruleUrl).toBeNull();
    });

    it('caps the number of findings', () => {
        const s = {
            runs: [{
                tool: { driver: { name: 'flood' } },
                results: Array.from({ length: LIMITS.maxFindings + 50 }, () => ({
                    ruleId: 'R',
                    message: { text: 'x' },
                    locations: [{ physicalLocation: { artifactLocation: { uri: 'a.js' }, region: { startLine: 1 } } }],
                })),
            }],
        };
        const { findings, stats } = parseSarif(s);
        expect(findings).toHaveLength(LIMITS.maxFindings);
        expect(stats.dropped).toBe(50);
    });

    it('truncates an enormous message', () => {
        const s = JSON.parse(JSON.stringify(SARIF));
        s.runs[0].results[0].message.text = 'x'.repeat(10_000);
        expect(parseSarif(s).findings[0].message.length).toBeLessThanOrEqual(LIMITS.maxMessageChars);
    });

    it('handles multiple runs and records each tool', () => {
        const s = { runs: [SARIF.runs[0], { ...SARIF.runs[0], tool: { driver: { name: 'Semgrep', rules: SARIF.runs[0].tool.driver.rules } } }] };
        const { findings, stats } = parseSarif(s);
        expect(findings).toHaveLength(2);
        expect(stats.tools).toEqual(['CodeQL', 'Semgrep']);
    });

    it('survives an empty or malformed log', () => {
        expect(parseSarif({}).findings).toEqual([]);
        expect(parseSarif({ runs: [] }).findings).toEqual([]);
        expect(parseSarif({ runs: [{}] }).findings).toEqual([]);
        expect(parseSarif(null).findings).toEqual([]);
    });
});

describe('parseRdjson', () => {
    const RD = {
        source: { name: 'golangci-lint', url: 'https://golangci-lint.run' },
        diagnostics: [{
            message: 'err113: do not define dynamic errors',
            location: { path: 'internal/api/handler.go', range: { start: { line: 88, column: 3 }, end: { line: 88 } } },
            severity: 'WARNING',
            code: { value: 'goerr113', url: 'https://github.com/Djarvur/go-err113' },
            suggestions: [{ text: 'errors.New("static")', range: { start: { line: 88 }, end: { line: 88 } } }],
        }],
    };

    it('extracts the finding, its rule URL and its fix', () => {
        const { findings } = parseRdjson(RD);
        expect(findings[0]).toMatchObject({
            ruleId: 'goerr113',
            severity: 'medium',
            filePath: 'internal/api/handler.go',
            line: 88,
            column: 3,
            tool: 'golangci-lint',
            ruleUrl: 'https://github.com/Djarvur/go-err113',
        });
        // A deterministic fix from the tool that found the problem beats a
        // model's suggestion for the same thing.
        expect(findings[0].suggestions[0].text).toBe('errors.New("static")');
    });

    it('falls back to the source URL when a rule has none', () => {
        const rd = JSON.parse(JSON.stringify(RD));
        delete rd.diagnostics[0].code.url;
        expect(parseRdjson(rd).findings[0].ruleUrl).toBe('https://golangci-lint.run');
    });

    it('maps rdjson severities', () => {
        const at = (sev) => {
            const rd = JSON.parse(JSON.stringify(RD));
            rd.diagnostics[0].severity = sev;
            return parseRdjson(rd).findings[0].severity;
        };
        expect(at('ERROR')).toBe('high');
        expect(at('WARNING')).toBe('medium');
        expect(at('INFO')).toBe('low');
        expect(at('nonsense')).toBe('medium');
    });

    it('parses rdjsonl line by line, skipping malformed lines', () => {
        // A truncated artifact should still yield the findings it has.
        const text = [
            '{"message":"one","location":{"path":"a.js","range":{"start":{"line":1}}}}',
            'not json at all',
            '{"message":"two","location":{"path":"b.js","range":{"start":{"line":2}}}}',
        ].join('\n');
        const { findings, stats } = parseRdjson(text);
        expect(findings.map(f => f.filePath)).toEqual(['a.js', 'b.js']);
        expect(stats.dropped).toBe(1);
    });

    it('drops a diagnostic with no message or a bad path', () => {
        const { findings, stats } = parseRdjson({
            diagnostics: [
                { location: { path: 'a.js' } },
                { message: 'x', location: { path: '../../etc/passwd' } },
            ],
        });
        expect(findings).toEqual([]);
        expect(stats.dropped).toBe(2);
    });
});

describe('parseReport', () => {
    it('dispatches on the sniffed format', () => {
        expect(parseReport(JSON.stringify(SARIF)).format).toBe(FORMAT.SARIF);
        expect(parseReport(SARIF).findings).toHaveLength(1);
    });

    it('honours an explicit format override', () => {
        expect(parseReport(SARIF, { format: FORMAT.SARIF }).findings).toHaveLength(1);
    });

    it('reports a parse failure instead of throwing', () => {
        const res = parseReport('{ this is not json');
        expect(res.findings).toEqual([]);
        expect(res.error).toBeTruthy();
    });

    it('names the problem when the format is unrecognised', () => {
        const res = parseReport('{"hello":"world"}');
        expect(res.error).toMatch(/SARIF 2\.1\.0, rdjson or rdjsonl/);
    });
});

describe('flattening must not relabel an external finding as ours', () => {
    // The review handler merges external findings into `staticResult.findings` so
    // the prompt sees them, which sends them through `normalizeStaticFinding`.
    // Overwriting `source` there erased the attribution the comment renderer
    // depends on, and prefixing the rule broke both the lookup URL and the
    // feedback ledger's rule matching.
    const { normalizeStaticFinding } = require('../../src/utils/findingsFlatten.js');

    it('keeps source and rule id intact for an external finding', () => {
        const [ext] = toReviewFindings(parseSarif(SARIF).findings);
        const flat = normalizeStaticFinding(ext);

        expect(flat.source).toBe('external');
        expect(flat.rule).toBe('js/sql-injection');   // NOT static/js/sql-injection
        expect(flat.attribution).toBe('Reported by CodeQL');
        expect(flat.ruleUrl).toBeTruthy();
    });

    it('still prefixes and labels our OWN analyzers', () => {
        const flat = normalizeStaticFinding({
            ruleId: 'no-eval', message: 'eval is unsafe', filePath: 'a.js', line: 3,
        });
        expect(flat.source).toBe('static');
        expect(flat.rule).toBe('static/no-eval');
    });

    it('leaves an explicit rule alone in both cases', () => {
        expect(normalizeStaticFinding({ rule: 'given', ruleId: 'x' }).rule).toBe('given');
    });
});

describe('toReviewFindings', () => {
    it('marks external findings as deterministic and attributes them', () => {
        const { findings } = parseSarif(SARIF);
        const [f] = toReviewFindings(findings);

        expect(f.source).toBe('external');
        // Not 'static': downstream filters on that for RepoSpector's OWN
        // analyzers, and these must stay attributable to the tool.
        expect(f.deterministic).toBe(true);
        expect(f.confidence).toBe(1.0);
        expect(f.attribution).toBe('Reported by CodeQL');
    });

    it('attributes an unnamed tool without claiming it was us', () => {
        const [f] = toReviewFindings([{ message: 'x', filePath: 'a.js' }]);
        expect(f.attribution).toMatch(/external tool/);
    });

    it('handles an empty list', () => {
        expect(toReviewFindings()).toEqual([]);
        expect(toReviewFindings([])).toEqual([]);
    });
});

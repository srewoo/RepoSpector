/**
 * externalFindings — read another tool's findings as first-class evidence.
 *
 * Every finding RepoSpector produces today it produced itself: its own analyzers,
 * or its own model. Both are things a reviewer has to decide whether to trust.
 * A finding from the team's OWN CodeQL, golangci-lint, Trivy, or Semgrep run is
 * categorically different — it cannot be hallucinated, it carries a rule id and
 * usually a documentation URL, and the people reading the review already trust
 * the tool that produced it.
 *
 * reviewdog's insight is that the FORMAT is the integration point. It does not
 * integrate with linters; it accepts their output. Support SARIF and rdjson and
 * you have support for every scanner a team already runs, without writing an
 * adapter per tool.
 *
 * ── What this module is and is not ──
 *
 * It is a PARSER and a NORMALIZER. It turns SARIF 2.1.0, rdjson, rdjsonl and
 * plain SARIF-like JSON into RepoSpector's static-finding shape, and nothing
 * else. Fetching (from a CI artifact, a check run, a pasted file) is
 * `ExternalFindingsService`; diff-scoping is `findingFilterMode.js`. Keeping
 * those apart is what makes this testable against real scanner output with no
 * network.
 *
 * ── Trust boundary ──
 *
 * A SARIF file arrives over the network from a CI job configured by the repo,
 * which on a public repo means it is attacker-controlled content. Everything
 * here treats it as hostile input: paths are rejected if they escape the repo,
 * every string is length-capped, counts are capped, and nothing is `eval`ed or
 * rendered as markup. A malicious report's worst case is that it wastes a slot.
 */

/** SARIF `level` → RepoSpector severity. */
const SARIF_LEVEL = Object.freeze({
    error: 'high',
    warning: 'medium',
    note: 'low',
    none: 'info',
});

/** rdjson `severity` → RepoSpector severity. */
const RD_SEVERITY = Object.freeze({
    ERROR: 'high',
    WARNING: 'medium',
    INFO: 'low',
    UNKNOWN_SEVERITY: 'info',
});

/**
 * A `security-severity` property (CodeQL, Trivy and Snyk all set it) is a better
 * signal than `level`, which most tools leave at "warning" for everything.
 * Thresholds follow the CVSS bands those tools document.
 */
function severityFromScore(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return null;
    if (n >= 9.0) return 'critical';
    if (n >= 7.0) return 'high';
    if (n >= 4.0) return 'medium';
    return 'low';
}

export const LIMITS = Object.freeze({
    maxFindings: 500,
    maxMessageChars: 2000,
    maxRuleIdChars: 200,
    maxPathChars: 400,
});

/** Detected input formats. */
export const FORMAT = Object.freeze({
    SARIF: 'sarif',
    RDJSON: 'rdjson',
    RDJSONL: 'rdjsonl',
    UNKNOWN: 'unknown',
});

/**
 * Identify the format of a raw report.
 *
 * Sniffed rather than configured, because the thing a user has is a file whose
 * format they may not know the name of, and a wrong `format:` in config would
 * silently yield zero findings — indistinguishable from a clean scan.
 *
 * @param {string|Object} raw
 * @returns {string} one of FORMAT
 */
export function detectFormat(raw) {
    if (!raw) return FORMAT.UNKNOWN;

    if (typeof raw === 'object') {
        if (Array.isArray(raw.runs)) return FORMAT.SARIF;
        if (Array.isArray(raw.diagnostics)) return FORMAT.RDJSON;
        return FORMAT.UNKNOWN;
    }

    const text = String(raw).trim();
    if (!text) return FORMAT.UNKNOWN;

    // rdjsonl is one JSON diagnostic per line, so it is not valid JSON as a whole.
    try {
        const parsed = JSON.parse(text);
        return detectFormat(parsed);
    } catch {
        const firstLine = text.split('\n').find(l => l.trim());
        if (!firstLine) return FORMAT.UNKNOWN;
        try {
            const one = JSON.parse(firstLine);
            if (one && (one.message !== undefined || one.location !== undefined)) return FORMAT.RDJSONL;
        } catch { /* not rdjsonl either */ }
        return FORMAT.UNKNOWN;
    }
}

/**
 * Is this a path inside the repository?
 *
 * SARIF URIs are relative to a base, and a report is free to claim
 * `../../etc/passwd` or `file:///home/runner/.ssh/id_rsa`. A finding on a path
 * outside the repo can never match the diff, so rejecting it costs nothing and
 * closes the door on a report steering the reviewer's attention off-repo.
 *
 * @param {string} path
 * @returns {string|null} the cleaned repo-relative path, or null
 */
export function normalizePath(path) {
    if (!path || typeof path !== 'string') return null;

    let p = path.trim();
    if (!p || p.length > LIMITS.maxPathChars) return null;

    // SARIF permits a file: URI. Anything else with a scheme is not a repo path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) {
        if (!/^file:/i.test(p)) return null;
        p = p.replace(/^file:(\/\/)?/i, '');
    }

    try {
        p = decodeURIComponent(p);
    } catch { /* keep the raw form if it is not valid percent-encoding */ }

    p = p.replace(/\\/g, '/').replace(/^\.\//, '');

    // Absolute paths and traversal: a CI runner's absolute path is useless to us
    // (it names a directory that does not exist on this machine) and traversal is
    // never legitimate.
    if (p.startsWith('/')) return null;
    if (p.split('/').includes('..')) return null;
    if (!p) return null;

    return p;
}

function clamp(s, max) {
    if (s === null || s === undefined) return null;
    const t = String(s).trim();
    if (!t) return null;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build the rule-documentation URL for a finding.
 *
 * This is the credibility payload. A finding that links to its rule's
 * documentation is one the reviewer can CHECK; one that does not is an assertion
 * they must take on faith. SARIF carries it as `helpUri` on the rule, rdjson as
 * `code.url`.
 *
 * Only http(s) survives: a `javascript:` or `data:` URL rendered as a link in the
 * panel would be a real hole, and a report is untrusted input.
 */
export function safeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const t = url.trim();
    if (!/^https?:\/\//i.test(t)) return null;
    if (t.length > 500) return null;
    return t;
}

/**
 * Parse a SARIF 2.1.0 log.
 *
 * @param {Object} sarif
 * @returns {{findings:Array, stats:Object}}
 */
export function parseSarif(sarif) {
    const findings = [];
    const stats = { runs: 0, results: 0, dropped: 0, tools: [] };

    for (const run of (sarif?.runs || [])) {
        stats.runs++;

        const driver = run?.tool?.driver || {};
        const toolName = clamp(driver.name, 100) || 'external';
        if (!stats.tools.includes(toolName)) stats.tools.push(toolName);

        // Rule metadata lives in the driver (and in extensions), keyed by id;
        // results reference it by `ruleId` or by `ruleIndex`. Both forms are in
        // the wild, so build one lookup that serves either.
        const rulesById = new Map();
        const rulesByIndex = [];
        const collectRules = (rules = []) => {
            rules.forEach((rule) => {
                if (!rule) return;
                rulesByIndex.push(rule);
                if (rule.id) rulesById.set(rule.id, rule);
            });
        };
        collectRules(driver.rules);
        for (const ext of (run?.tool?.extensions || [])) collectRules(ext?.rules);

        for (const result of (run?.results || [])) {
            if (findings.length >= LIMITS.maxFindings) { stats.dropped++; continue; }
            stats.results++;

            const rule = (result.ruleId && rulesById.get(result.ruleId))
                || (Number.isInteger(result.ruleIndex) ? rulesByIndex[result.ruleIndex] : null)
                || {};

            const loc = result.locations?.[0]?.physicalLocation || {};
            const path = normalizePath(loc.artifactLocation?.uri);
            if (!path) { stats.dropped++; continue; }

            const region = loc.region || {};
            const line = Number.isInteger(region.startLine) ? region.startLine : null;
            // A result with no line cannot be placed in a diff. Kept as a
            // file-level finding rather than dropped — "this file has a
            // vulnerable dependency" is a legitimate file-level statement.

            const message = clamp(
                result.message?.text
                    || result.message?.markdown
                    || rule.shortDescription?.text
                    || rule.id,
                LIMITS.maxMessageChars,
            );
            if (!message) { stats.dropped++; continue; }

            const scoreSeverity = severityFromScore(
                rule.properties?.['security-severity']
                ?? result.properties?.['security-severity'],
            );

            findings.push({
                ruleId: clamp(result.ruleId || rule.id, LIMITS.maxRuleIdChars) || 'external',
                severity: scoreSeverity
                    || SARIF_LEVEL[result.level]
                    || SARIF_LEVEL[rule.defaultConfiguration?.level]
                    || 'medium',
                category: inferCategory(rule, result),
                message,
                filePath: path,
                line,
                endLine: Number.isInteger(region.endLine) ? region.endLine : line,
                column: Number.isInteger(region.startColumn) ? region.startColumn : null,
                codeSnippet: clamp(region.snippet?.text, 400),
                ruleUrl: safeUrl(rule.helpUri),
                ruleDescription: clamp(rule.fullDescription?.text || rule.shortDescription?.text, 500),
                cwe: extractCwe(rule, result),
                tool: toolName,
                // A tool's own fingerprint is a better dedupe key than
                // file+line+rule, because it survives the code moving.
                fingerprint: clamp(
                    result.fingerprints?.['primaryLocationLineHash']
                    || result.partialFingerprints?.['primaryLocationLineHash'],
                    120,
                ),
            });
        }
    }

    return { findings, stats };
}

/**
 * Parse rdjson / rdjsonl (reviewdog's own diagnostic format).
 *
 * @param {Object|string} raw - parsed rdjson object, or rdjsonl text
 * @returns {{findings:Array, stats:Object}}
 */
export function parseRdjson(raw) {
    const findings = [];
    const stats = { runs: 1, results: 0, dropped: 0, tools: [] };

    let diagnostics = [];
    let toolName = 'external';

    if (typeof raw === 'string') {
        // rdjsonl: one diagnostic per line. A malformed line is skipped, not
        // fatal — a truncated artifact should still yield the findings it has.
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try {
                diagnostics.push(JSON.parse(t));
            } catch {
                stats.dropped++;
            }
        }
    } else {
        diagnostics = raw?.diagnostics || [];
        toolName = clamp(raw?.source?.name, 100) || 'external';
    }

    if (!stats.tools.includes(toolName)) stats.tools.push(toolName);
    const sourceUrl = typeof raw === 'object' ? safeUrl(raw?.source?.url) : null;

    for (const d of diagnostics) {
        if (findings.length >= LIMITS.maxFindings) { stats.dropped++; continue; }
        stats.results++;

        const path = normalizePath(d?.location?.path);
        if (!path) { stats.dropped++; continue; }

        const message = clamp(d?.message, LIMITS.maxMessageChars);
        if (!message) { stats.dropped++; continue; }

        const range = d?.location?.range || {};

        findings.push({
            ruleId: clamp(d?.code?.value, LIMITS.maxRuleIdChars) || 'external',
            severity: RD_SEVERITY[d?.severity] || 'medium',
            category: 'lint',
            message,
            filePath: path,
            line: Number.isInteger(range.start?.line) ? range.start.line : null,
            endLine: Number.isInteger(range.end?.line) ? range.end.line : null,
            column: Number.isInteger(range.start?.column) ? range.start.column : null,
            codeSnippet: null,
            ruleUrl: safeUrl(d?.code?.url) || sourceUrl,
            ruleDescription: null,
            cwe: null,
            tool: toolName,
            fingerprint: null,
            // rdjson carries machine-applicable fixes. Carried through because a
            // deterministic fix from the tool that found the problem is worth
            // more than a model's suggestion for the same thing.
            suggestions: Array.isArray(d?.suggestions)
                ? d.suggestions.slice(0, 3).map(s => ({
                    text: clamp(s?.text, 1000),
                    startLine: s?.range?.start?.line ?? null,
                    endLine: s?.range?.end?.line ?? null,
                })).filter(s => s.text)
                : [],
        });
    }

    return { findings, stats };
}

/** CWE from SARIF tags (`external/cwe/cwe-079`) or a relationship. */
function extractCwe(rule, result) {
    const tags = [
        ...(rule?.properties?.tags || []),
        ...(result?.properties?.tags || []),
    ];
    for (const tag of tags) {
        const m = String(tag).match(/cwe[-/](\d+)/i);
        // SARIF tags zero-pad (`external/cwe/cwe-089`); RepoSpector's own
        // analyzers emit `CWE-89`. Two spellings of one id would defeat every
        // dedupe and grouping that keys on `cwe`, so normalise to the unpadded
        // form the rest of the pipeline already uses.
        if (m) return `CWE-${String(Number(m[1]))}`;
    }
    return null;
}

/**
 * Category, from the tool's own tags where it states them.
 *
 * Guessed from the message ONLY as a last resort and only for unambiguous
 * markers: a mis-categorised finding is sorted and filtered wrongly downstream,
 * which is worse than one landing in the generic bucket.
 */
function inferCategory(rule, result) {
    const tags = [
        ...(rule?.properties?.tags || []),
        ...(result?.properties?.tags || []),
    ].map(t => String(t).toLowerCase());

    if (tags.some(t => t.includes('security') || t.startsWith('cwe') || t.includes('injection'))) {
        return 'security';
    }
    if (tags.some(t => t.includes('performance'))) return 'performance';
    if (tags.some(t => t.includes('correctness') || t.includes('bug'))) return 'bug';
    if (tags.some(t => t.includes('maintainability') || t.includes('style'))) return 'lint';

    if (rule?.properties?.['security-severity'] !== undefined) return 'security';
    return 'lint';
}

/**
 * Parse a report of any supported format.
 *
 * @param {string|Object} raw
 * @param {Object} [opts]
 * @param {string} [opts.format] - override the sniffer
 * @returns {{findings:Array, format:string, stats:Object, error:string|null}}
 */
export function parseReport(raw, { format = null } = {}) {
    const detected = format || detectFormat(raw);
    const fail = (error) => ({ findings: [], format: detected, stats: { runs: 0, results: 0, dropped: 0, tools: [] }, error });

    try {
        if (detected === FORMAT.RDJSONL) {
            const { findings, stats } = parseRdjson(typeof raw === 'string' ? raw : '');
            return { findings, format: detected, stats, error: null };
        }

        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;

        if (detected === FORMAT.SARIF) {
            const { findings, stats } = parseSarif(obj);
            return { findings, format: detected, stats, error: null };
        }
        if (detected === FORMAT.RDJSON) {
            const { findings, stats } = parseRdjson(obj);
            return { findings, format: detected, stats, error: null };
        }

        return fail('Unrecognised report format — expected SARIF 2.1.0, rdjson or rdjsonl.');
    } catch (e) {
        return fail(`Could not parse report: ${e?.message}`);
    }
}

/**
 * Convert parsed external findings into the shape the review pipeline consumes.
 *
 * `source: 'external'` rather than `'static'` deliberately. Downstream code
 * filters on `source === 'static'` for RepoSpector's OWN analyzers, and these
 * must be attributable to the tool that produced them — both so the review can
 * say "your golangci-lint found this" and so a bad external report is traceable
 * to its source rather than blamed on RepoSpector.
 *
 * @param {Array} findings - from parseReport
 * @returns {Array}
 */
export function toReviewFindings(findings = []) {
    return findings.map(f => ({
        ...f,
        source: 'external',
        // Deterministic: a scanner either matched or it did not. This is the
        // whole point — these findings do not need the model's confidence
        // estimate, and giving them one would understate them.
        confidence: 1.0,
        deterministic: true,
        // Attribution the panel and the posted comment both render.
        attribution: f.tool ? `Reported by ${f.tool}` : 'Reported by an external tool',
    }));
}

export default {
    detectFormat,
    parseReport,
    parseSarif,
    parseRdjson,
    toReviewFindings,
    normalizePath,
    safeUrl,
    FORMAT,
    LIMITS,
};

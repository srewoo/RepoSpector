/**
 * Final precision gate between candidate generation and anything a user sees.
 *
 * Earlier stages deliberately cast a wide net. This stage has the opposite job:
 * silence is preferable to an unproven review comment. A candidate must be a
 * concrete defect, point to evidence in the changed code, and clear both the
 * confidence and reviewer-value thresholds. The same accepted list drives the
 * UI, verdict, cache, metrics, and posting.
 */

const NON_PROBLEM_CATEGORIES = new Set([
    'style',
    'lint',
    'naming',
    'formatting',
    'documentation',
    'docs',
    'maintainability',
    'conventions',
    'coverage',
    'testing',
    'test',
    'quality',
    'best-practice',
]);

const NON_PROBLEM_TEXT = [
    /\b(no tests?|missing tests?|test coverage|add (?:a |more )?tests?)\b/i,
    /\b(naming|formatting|readability|code style|style guide|convention)\b/i,
    /^(consider|prefer)\b|\b(could be cleaner|more maintainable|best practice)\b/i,
    /\b(todo|fixme)\b/i,
];

const LOW_SEVERITIES = new Set(['low', 'info', 'nit', 'nitpick']);
const AUTHORITATIVE_TOOLS = new Set(['secrets', 'dependency', 'osv', 'eol']);

function normalizedConfidence(finding) {
    const n = Number(finding?.confidence);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
}

function normalizedScore(finding) {
    const n = Number(finding?.score);
    return Number.isFinite(n) ? n : null;
}

function textOf(finding) {
    return [
        finding?.title,
        finding?.description,
        finding?.message,
        finding?.suggestion,
    ].filter(Boolean).join(' ');
}

function hasLocation(finding) {
    const file = finding?.file || finding?.filePath;
    return !!file && Number.isFinite(Number(finding?.line)) && Number(finding.line) > 0;
}

function isBreakingCrossRepoFact(finding) {
    return finding?.source === 'cross-repo'
        && String(finding?.severity || '').toLowerCase() === 'blocking'
        && normalizedConfidence(finding) >= 0.8
        && !!finding?.crossRepo?.symbol;
}

function isAuthoritativeExternalFact(finding) {
    const tool = String(finding?.tool || '').toLowerCase();
    if (!AUTHORITATIVE_TOOLS.has(tool)) return false;
    if (!(finding?.file || finding?.filePath)) return false;
    if (normalizedConfidence(finding) < 0.85) return false;

    if (tool === 'secrets') return !!(finding?.ruleId || finding?.secretType);
    if (tool === 'dependency' || tool === 'osv') {
        return !!(finding?.cve || finding?.vulnerabilityId || finding?.packageName);
    }
    if (tool === 'eol') return finding?.isEOL === true;
    return false;
}

function hasChangedCodeEvidence(finding) {
    if (!hasLocation(finding)) return false;
    if (finding?._evidence?.citedLine != null) return true;
    return !!String(finding?.evidence || finding?.codeSnippet || '').trim();
}

/**
 * Keep only high-confidence, high-value, evidence-backed defects.
 *
 * @param {Array<object>} findings
 * @param {object} options
 * @param {number} [options.minConfidence=0.8]
 * @param {number} [options.minScore=7]
 * @returns {{findings:Array<object>, dropped:Array<object>, stats:object}}
 */
export function filterGenuineProblems(findings = [], options = {}) {
    const minConfidence = Number(options.minConfidence ?? 0.8);
    const minScore = Number(options.minScore ?? 7);
    const kept = [];
    const dropped = [];
    const reasons = {};

    const reject = (finding, reason) => {
        reasons[reason] = (reasons[reason] || 0) + 1;
        dropped.push({ ...finding, _precisionDrop: reason });
    };

    for (const finding of findings || []) {
        if (!finding || typeof finding !== 'object') continue;

        if (finding.needsHumanReview) {
            reject(finding, 'open-question');
            continue;
        }
        if (finding._lowValue) {
            reject(finding, 'low-value');
            continue;
        }

        const severity = String(finding.severity || '').toLowerCase();
        if (LOW_SEVERITIES.has(severity)) {
            reject(finding, 'non-problem-severity');
            continue;
        }

        const category = String(finding.category || finding.type || '').toLowerCase();
        const text = textOf(finding);
        if (NON_PROBLEM_CATEGORIES.has(category) || NON_PROBLEM_TEXT.some((re) => re.test(text))) {
            reject(finding, 'review-commentary');
            continue;
        }

        // These are independently verifiable facts. A removed public symbol still
        // used by an indexed consumer has no line in the current diff, and OSV/EOL
        // findings may point to a manifest rather than a precise source line.
        if (isBreakingCrossRepoFact(finding) || isAuthoritativeExternalFact(finding)) {
            kept.push(finding);
            continue;
        }

        if (!hasChangedCodeEvidence(finding)) {
            reject(finding, 'missing-changed-code-evidence');
            continue;
        }

        const confidence = normalizedConfidence(finding);
        if (confidence == null || confidence < minConfidence) {
            reject(finding, 'confidence');
            continue;
        }

        const score = normalizedScore(finding);
        if (score == null || score < minScore || finding.scoreSource === 'default') {
            reject(finding, 'reviewer-value');
            continue;
        }

        kept.push(finding);
    }

    return {
        findings: kept,
        dropped,
        stats: {
            input: (findings || []).length,
            kept: kept.length,
            dropped: dropped.length,
            minConfidence,
            minScore,
            byReason: reasons,
        },
    };
}

export function summarizeGenuineProblems(findings = []) {
    const bySeverity = {};
    const byCategory = {};
    for (const finding of findings) {
        const severity = String(finding.severity || 'unknown').toLowerCase();
        const category = String(finding.category || finding.type || 'unknown').toLowerCase();
        bySeverity[severity] = (bySeverity[severity] || 0) + 1;
        byCategory[category] = (byCategory[category] || 0) + 1;
    }
    return { total: findings.length, bySeverity, byCategory };
}

export function buildPrecisionAnalysis(findings = [], options = {}) {
    if (options.skipped) {
        return `## Review not completed\n\n${options.reason || 'RepoSpector did not inspect the changed code.'}`;
    }
    if (options.partial) {
        const suffix = findings.length
            ? `${findings.length} genuine problem${findings.length === 1 ? '' : 's'} found in the reviewed portion.`
            : 'No genuine problems were found in the reviewed portion.';
        return `## Partial review\n\n${suffix} Unreviewed files are not considered clean.`;
    }
    if (findings.length === 0) {
        return '## Clean review\n\nNo genuine problems were found in the changed code.';
    }
    return `## ${findings.length} genuine problem${findings.length === 1 ? '' : 's'} found\n\nOnly evidence-backed defects that passed the confidence and reviewer-value gates are reported.`;
}

export default { filterGenuineProblems, summarizeGenuineProblems, buildPrecisionAnalysis };

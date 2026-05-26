/**
 * Canonical Review Schema for RepoSpector.
 *
 * Every reviewer (LLM, ESLint, Semgrep, Secrets, Compliance, ...) emits
 * Findings in this shape. The orchestrator merges them into a single
 * VerdictReport that the UI, cache, and (future) webhook bot all consume.
 *
 * Schema is a deliberate superset of the legacy parseLLMAnalysis output —
 * use toCanonicalFinding() to lift legacy shapes without breaking callers.
 */

export const PHASE = Object.freeze({
    DEEP: 'deep',        // logic, security, architecture, performance (LLM reasoning)
    STANDARDS: 'standards', // lint, conventions, coverage, secrets, SCA
});

export const SEVERITY = Object.freeze({
    BLOCKING: 'blocking',
    SUGGESTION: 'suggestion',
    NITPICK: 'nitpick',
});

export const VERDICT = Object.freeze({
    APPROVE: 'APPROVE',
    NEEDS_DISCUSSION: 'NEEDS_DISCUSSION',
    BLOCK: 'BLOCK',
    DEFER: 'DEFER',
    SKIP: 'SKIP',
});

export const CATEGORY = Object.freeze({
    SECURITY: 'security',
    LOGIC: 'logic',
    PERFORMANCE: 'performance',
    ARCHITECTURE: 'architecture',
    LINT: 'lint',
    CONVENTIONS: 'conventions',
    COVERAGE: 'coverage',
    DEPENDENCIES: 'dependencies',
    SECRETS: 'secrets',
    DOCS: 'docs',
    TOOLING: 'tooling',
});

// Map legacy/LLM-emitted severities → canonical. Includes the canonical
// names themselves so this is idempotent — toCanonicalFinding can run more
// than once on the same finding without degrading severity.
const LEGACY_SEVERITY = {
    critical: SEVERITY.BLOCKING,
    high: SEVERITY.BLOCKING,
    blocker: SEVERITY.BLOCKING,
    blocking: SEVERITY.BLOCKING,
    must: SEVERITY.BLOCKING,
    medium: SEVERITY.SUGGESTION,
    should: SEVERITY.SUGGESTION,
    suggestion: SEVERITY.SUGGESTION,
    warning: SEVERITY.SUGGESTION,
    low: SEVERITY.NITPICK,
    info: SEVERITY.NITPICK,
    nit: SEVERITY.NITPICK,
    nitpick: SEVERITY.NITPICK,
};

/**
 * Lift any reviewer's raw finding into the canonical shape.
 * Missing fields default to safe values — never throw on bad input.
 */
export function toCanonicalFinding(raw, defaults = {}) {
    if (!raw || typeof raw !== 'object') return null;

    const sevKey = String(raw.severity ?? defaults.severity ?? 'suggestion').toLowerCase();
    const severity = LEGACY_SEVERITY[sevKey] ?? SEVERITY.SUGGESTION;

    return {
        id: raw.id ?? makeFindingId(),
        phase: raw.phase ?? defaults.phase ?? PHASE.DEEP,
        severity,
        category: raw.category ?? raw.type ?? defaults.category ?? CATEGORY.LOGIC,
        file: raw.file ?? raw.relevant_file ?? null,
        line: normalizeLine(raw.line ?? raw.line_number),
        rule: raw.rule ?? null,                       // e.g. "eslint:no-shadow", "cross-file-coupling:foo.ts"
        title: raw.title ?? null,
        suggestion: raw.suggestion ?? raw.message ?? raw.description ?? '',
        evidence: raw.evidence ?? raw.codeSnippet ?? null,
        source: raw.source ?? defaults.source ?? 'llm', // llm | eslint | semgrep | secrets | osv | compliance
    };
}

function normalizeLine(line) {
    if (line == null) return null;
    const n = Number.parseInt(line, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

let _seq = 0;
export function makeFindingId() {
    _seq = (_seq + 1) % 1_000_000;
    return `f_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * Roll a list of canonical findings into a verdict per Bastion's rules:
 *   any BLOCKING → BLOCK
 *   else any SUGGESTION → NEEDS_DISCUSSION
 *   else → APPROVE
 * Skip-rule engine may override with DEFER or SKIP before this runs.
 */
export function rollupVerdict(findings) {
    if (!Array.isArray(findings) || findings.length === 0) return VERDICT.APPROVE;
    let hasSuggestion = false;
    for (const f of findings) {
        if (f.severity === SEVERITY.BLOCKING) return VERDICT.BLOCK;
        if (f.severity === SEVERITY.SUGGESTION) hasSuggestion = true;
    }
    return hasSuggestion ? VERDICT.NEEDS_DISCUSSION : VERDICT.APPROVE;
}

/**
 * Build the final report consumed by the UI / cache / webhook bot.
 * `summary` is split by phase so we can render two sections (Bastion-style).
 */
export function buildVerdictReport({ findings = [], summary = {}, meta = {}, override } = {}) {
    const canonical = findings.map((f) => toCanonicalFinding(f)).filter(Boolean);
    const verdict = override ?? rollupVerdict(canonical);
    return {
        schemaVersion: 1,
        verdict,
        findings: canonical,
        summary: {
            deep: summary.deep ?? '',
            standards: summary.standards ?? '',
        },
        counts: countBySeverity(canonical),
        meta: {
            generatedAt: new Date().toISOString(),
            ...meta,
        },
    };
}

function countBySeverity(findings) {
    const counts = { blocking: 0, suggestion: 0, nitpick: 0, total: findings.length };
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return counts;
}

/**
 * Group findings into the two phase buckets — convenience for UI rendering.
 */
export function partitionByPhase(findings) {
    const out = { deep: [], standards: [] };
    for (const f of findings) (out[f.phase] ?? out.deep).push(f);
    return out;
}

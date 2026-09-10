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

import { governVerdict, createCompleteness } from '../utils/reviewCompleteness.js';

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
    // P0-1. Distinct from SKIP (nothing was read on purpose) and from
    // NEEDS_DISCUSSION (something was read and is arguable): the pipeline
    // tried to read the change and could not finish. It is the only honest
    // answer when there are no blocking findings but also no assurance.
    INCOMPLETE: 'INCOMPLETE',
});

/**
 * Kinds of expertise a finding can be escalated to.
 *
 * From the checklist's "Experts' Opinion" section — "should a security or
 * usability expert look over this before it is accepted?" — and Three Man Team's
 * Escalate-to-Architect bucket. Both treat "a human must decide this" as a
 * first-class review outcome rather than a weak finding.
 */
export const EXPERTISE = Object.freeze({
    SECURITY: 'security',
    ARCHITECTURE: 'architecture',
    PRODUCT: 'product',
    DOMAIN: 'domain',
    OPERATIONS: 'operations',
    ACCESSIBILITY: 'accessibility',
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
        description: raw.description ?? raw.message ?? '',
        impact: raw.impact ?? null,
        confidence: normalizeConfidence(raw.confidence),
        score: normalizeScore(raw.score),
        scoreSource: raw.scoreSource ?? null,
        tool: raw.tool ?? null,
        source: raw.source ?? defaults.source ?? 'llm', // llm | eslint | semgrep | secrets | osv | compliance
        // ── Escalation ──────────────────────────────────────────────────────
        // "This cannot be settled from the diff; a human with specific
        // expertise must decide." That is a DIFFERENT claim from low confidence,
        // and the distinction is load-bearing: a low-confidence finding should be
        // suppressed, whereas an escalation suppressed is a question nobody ever
        // gets asked. Before this existed the pipeline had no way to say it, so
        // the reviewer's only options were to assert something it could not
        // support or to stay silent.
        needsHumanReview: raw.needsHumanReview === true,
        escalation: raw.needsHumanReview === true
            ? {
                expertise: normalizeExpertise(raw.expertise ?? raw.escalation?.expertise),
                reason: raw.escalationReason ?? raw.escalation?.reason ?? raw.suggestion ?? '',
            }
            : null,
    };
}

function normalizeConfidence(value) {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const normalized = n > 1 ? n / 100 : n;
    return Math.min(1, Math.max(0, normalized));
}

function normalizeScore(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : null;
}

/** Unknown or missing expertise falls back to DOMAIN rather than being dropped. */
function normalizeExpertise(value) {
    const key = String(value ?? '').toLowerCase();
    return Object.values(EXPERTISE).includes(key) ? key : EXPERTISE.DOMAIN;
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
 * Roll a list of canonical findings into a verdict:
 *   any BLOCKING → BLOCK
 *   else any SUGGESTION → NEEDS_DISCUSSION
 *   else → APPROVE
 * Skip-rule engine may override with DEFER or SKIP before this runs.
 */
export function rollupVerdict(findings) {
    if (!Array.isArray(findings) || findings.length === 0) return VERDICT.APPROVE;
    let hasSuggestion = false;
    let hasEscalation = false;
    for (const f of findings) {
        if (f.severity === SEVERITY.BLOCKING) return VERDICT.BLOCK;
        if (f.severity === SEVERITY.SUGGESTION) hasSuggestion = true;
        if (f.needsHumanReview) hasEscalation = true;
    }
    // An open question is not an approval. It is also not a block: the reviewer
    // is not claiming something is wrong, only that it cannot tell from the
    // diff — which is precisely what NEEDS_DISCUSSION means.
    return (hasSuggestion || hasEscalation) ? VERDICT.NEEDS_DISCUSSION : VERDICT.APPROVE;
}

/**
 * Build the final report consumed by the UI / cache / webhook bot.
 * `summary` is split by phase so we can render two sections.
 */
export function buildVerdictReport({ findings = [], summary = {}, meta = {}, override, completeness = null } = {}) {
    const canonical = findings.map((f) => toCanonicalFinding(f)).filter(Boolean);
    const rolled = override ?? rollupVerdict(canonical);

    // P0-1: completeness governs the verdict, and it does so here rather than
    // in each caller, because "approve" is produced in four places and every
    // one of them used to be free to approve a run that never finished.
    // Blocking outcomes pass through untouched — a defect found in code that
    // WAS read stays a defect.
    const contract = completeness ?? meta?.completeness ?? null;
    const governed = governVerdict({ verdict: rolled }, contract);
    const verdict = governed.verdict ?? rolled;

    return {
        schemaVersion: 1,
        verdict,
        findings: canonical,
        // Derived, not stored separately: an escalation IS a finding, and keeping
        // a second copy would let the two disagree after any later filtering.
        escalations: canonical.filter((f) => f.needsHumanReview),
        summary: {
            deep: summary.deep ?? '',
            standards: summary.standards ?? '',
        },
        counts: countBySeverity(canonical),
        meta: {
            generatedAt: new Date().toISOString(),
            ...meta,
            completeness: contract ? createCompleteness(contract) : (meta?.completeness ?? null),
            incomplete: governed.reasons.length > 0,
            incompleteReasons: governed.reasons,
            verdictDowngradedForIncompleteness: governed.downgraded,
        },
    };
}

function countBySeverity(findings) {
    const counts = { blocking: 0, suggestion: 0, nitpick: 0, escalations: 0, total: findings.length };
    for (const f of findings) {
        counts[f.severity] = (counts[f.severity] ?? 0) + 1;
        if (f.needsHumanReview) counts.escalations++;
    }
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

import { redactSecrets, wrapUntrusted, type Category, type Finding, type JudgeResult } from '@repospector/core';
import type { ReviewPlan } from './plan.js';
import type { RevisionSource } from './source.js';

const CONTEXT_LINES = 3;
const MAX_CODE_LINES = 120;

/** File paths mentioned by untrusted tool input (findings or verdicts), for preloading only. */
export function referencedFiles(items: readonly unknown[]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3 || typeof v !== 'object' || v === null) return;
    const rec = v as Record<string, unknown>;
    if (typeof rec.file === 'string') out.add(rec.file);
    for (const child of Object.values(rec)) {
      if (Array.isArray(child)) child.slice(0, 20).forEach((c) => visit(c, depth + 1));
      else visit(child, depth + 1);
    }
  };
  items.slice(0, 500).forEach((i) => visit(i, 0));
  // 50 findings x (1 location + 10 evidence ranges) fits under this cap.
  return [...out].slice(0, 600);
}

/** What the verifier sees: the claim and the cited code, not the specialist's reasoning or confidence. */
export function packForVerifier(f: Finding, source: RevisionSource) {
  const blocks: string[] = [];
  let budget = MAX_CODE_LINES;
  for (const e of f.evidence) {
    if (budget <= 0) break;
    const end = Math.min(e.endLine + CONTEXT_LINES, e.startLine - CONTEXT_LINES + budget);
    const code = source.snippet(e.file, e.startLine - CONTEXT_LINES, end);
    budget -= code.split('\n').length;
    blocks.push(`--- ${e.file} ---\n${code}`);
  }
  return {
    id: f.id,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
    severity: f.severity,
    category: f.category,
    claim: f.claim,
    evidence: f.evidence,
    code: wrapUntrusted('code', redactSecrets(blocks.join('\n'))),
  };
}

export function formatFinal(result: JudgeResult, plan: ReviewPlan, specialists: readonly Category[]) {
  const findings = result.kept.map((f) => ({
    id: f.id,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
    severity: f.severity,
    category: f.category,
    claim: f.claim,
    reasoning: f.reasoning,
    evidence: f.evidence,
    status: f.status,
    ...(f.suspectedBecause ? { suspectedBecause: f.suspectedBecause } : {}),
    verification: f.verdict.reason,
    fingerprint: f.fingerprint,
    confidence: f.confidence,
    expectedPrecision: f.expectedPrecision,
    confidenceLabel:
      f.expectedPrecision === null
        ? `uncalibrated confidence ${f.confidence.toFixed(2)}`
        : `expected precision ${(f.expectedPrecision * 100).toFixed(0)}%`,
  }));
  const notCovered = ['requirements: no linked issue was provided'];
  if (!specialists.includes('rules')) notCovered.push('team rules: none found, or not run at this depth');
  return {
    findings,
    dropped: result.dropped,
    coverage: {
      reviewedFiles: plan.files.map((f) => f.path),
      specialistsRun: specialists,
      skipped: plan.skipped,
      notIncluded: plan.notIncluded,
      notCovered,
    },
    summary: `${findings.filter((f) => f.status === 'verified').length} verified and ${findings.filter((f) => f.status === 'suspected').length} suspected finding(s), ${result.dropped.length} duplicate(s) merged, ${plan.files.length} file(s) reviewed${
      plan.notIncluded.length ? `, ${plan.notIncluded.length} file(s) not reviewed (size limit)` : ''
    }.`,
  };
}

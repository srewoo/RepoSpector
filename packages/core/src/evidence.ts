import type { FindingInput, LineRange } from './finding.js';

/** Line counts of files at the reviewed revision. Undefined means the file does not exist there. */
export interface LineSource {
  lineCount(path: string): number | undefined;
}

export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkRange(range: LineRange, source: LineSource): CheckResult {
  const count = source.lineCount(range.file);
  if (count === undefined) return { ok: false, reason: `${range.file} does not exist at the reviewed revision` };
  if (range.endLine > count) {
    return {
      ok: false,
      reason: `${range.file}:${range.startLine}-${range.endLine} is outside the file (${count} lines)`,
    };
  }
  return { ok: true };
}

/** A finding's location and every evidence range must point at lines that exist. */
export function checkEvidence(finding: FindingInput, source: LineSource): CheckResult {
  const location = checkRange({ file: finding.file, startLine: finding.startLine, endLine: finding.endLine }, source);
  if (!location.ok) return location;
  for (const range of finding.evidence) {
    const r = checkRange(range, source);
    if (!r.ok) return r;
  }
  return { ok: true };
}

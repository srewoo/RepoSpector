import { buildFixPrompt, parseFix, redactSecrets } from '@repospector/core';
import { estimateCost, type ModelChoice } from '../providers/presets.js';
import type { ModelProvider } from '../providers/types.js';
import type { ReviewFinding, RunRecord } from './run-types.js';

export interface FixDeps {
  readonly provider: ModelProvider;
  readonly prices?: ModelChoice | null | undefined;
  /** The file's text at a commit, from the git host. */
  readonly fileAt: (path: string, sha: string) => Promise<string>;
  readonly save: (run: RunRecord) => Promise<void>;
}

/**
 * Suggests a fix for one finding of a finished review, on request: reads the file at the reviewed
 * commit, asks the model for the smallest change to the lines around the finding, and stores it on
 * the finding (or why there is none). One model call; its cost is added to the run.
 */
export async function suggestFix(run: RunRecord, findingId: string, d: FixDeps): Promise<RunRecord> {
  const finding = run.findings?.find((f) => f.id === findingId);
  if (!finding || !run.headSha) return run;
  const update = async (patch: Partial<ReviewFinding>, extra: Partial<RunRecord> = {}): Promise<RunRecord> => {
    const next: RunRecord = { ...run, ...extra, findings: (run.findings ?? []).map((f) => (f.id === findingId ? { ...f, ...patch } : f)), updatedAt: Date.now() };
    await d.save(next);
    return next;
  };
  try {
    const content = redactSecrets(await d.fileAt(finding.file, run.headSha));
    const req = { file: finding.file, line: finding.line, claim: finding.claim, content };
    const r = await d.provider.complete({ prompt: buildFixPrompt(run.title ?? '', req), maxTokens: 6_000, effort: 'medium' });
    const usage = { inputTokens: run.usage.inputTokens + r.usage.inputTokens, outputTokens: run.usage.outputTokens + r.usage.outputTokens };
    const cost = d.prices ? { costUsd: estimateCost(d.prices, usage.inputTokens, usage.outputTokens) } : {};
    const fix = r.stop === 'refusal' ? { none: `${r.model} declined to suggest a change` } : parseFix(r.text, req);
    if (!fix) return await update({ fixUnavailable: 'the model reply could not be used as a change to these lines', fix: undefined }, { usage, ...cost });
    if ('none' in fix) return await update({ fixUnavailable: fix.none, fix: undefined }, { usage, ...cost });
    return await update({ fix, fixUnavailable: undefined }, { usage, ...cost });
  } catch (e) {
    return update({ fixUnavailable: `could not suggest a fix: ${(e as Error).message.slice(0, 160)}`, fix: undefined });
  }
}

import { z } from 'zod';
import type { BaselineFinding } from './baseline.js';
import type { LlmClient } from './llm.js';

/** Diff-only verifier: same principles as the MCP verifier, without tools. */
export { VERIFY_PROMPT } from '@repospector/core';
import { VERIFY_PROMPT } from '@repospector/core';

/** Same rule as VERIFY_PROMPT; the verifier may also read the repository at the PR head. */
export const VERIFY_REPO_ADDENDUM = `You can read the repository at the PR head with Read, Grep and Glob; your working directory is its root. Before deciding a finding that depends on code outside the diff (callers, guards, types, config, how errors are handled), read that code. Read only what the findings need.`;

const VerdictsSchema = z.array(z.object({ index: z.number().int().nonnegative(), keep: z.boolean(), reason: z.string() }));

export interface VerifyResult {
  readonly kept: BaselineFinding[];
  readonly dropped: { index: number; reason: string }[];
  /** Findings the verifier gave no verdict for; kept, so a lazy verifier cannot lose recall silently. */
  readonly unverified: number;
  readonly parseFailed: boolean;
  readonly turns?: number;
}

export function applyVerdicts(findings: readonly BaselineFinding[], reply: string): VerifyResult {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  let verdicts: z.infer<typeof VerdictsSchema> | null = null;
  if (start !== -1 && end > start) {
    try {
      const parsed = VerdictsSchema.safeParse(JSON.parse(reply.slice(start, end + 1)));
      if (parsed.success) verdicts = parsed.data;
    } catch {
      /* handled below */
    }
  }
  if (!verdicts) return { kept: [...findings], dropped: [], unverified: findings.length, parseFailed: true };
  const byIndex = new Map(verdicts.map((v) => [v.index, v]));
  const dropped = verdicts.filter((v) => !v.keep && v.index < findings.length).map((v) => ({ index: v.index, reason: v.reason }));
  const droppedIdx = new Set(dropped.map((d) => d.index));
  return {
    kept: findings.filter((_, i) => !droppedIdx.has(i)),
    dropped,
    unverified: findings.filter((_, i) => !byIndex.has(i)).length,
    parseFailed: false,
  };
}

export async function verifyFindings(
  title: string,
  diff: string,
  findings: readonly BaselineFinding[],
  llm: LlmClient,
  model: string,
  repoDir?: string,
): Promise<VerifyResult> {
  if (findings.length === 0) return { kept: [], dropped: [], unverified: 0, parseFailed: false };
  const list = findings.map((f, i) => `${i}. ${f.file}:${f.line} — ${f.claim}`).join('\n');
  const head = repoDir ? `${VERIFY_PROMPT}\n\n${VERIFY_REPO_ADDENDUM}` : VERIFY_PROMPT;
  const prompt = `${head}\n\nPR title: ${title}\n\n<findings>\n${list}\n</findings>\n\n<diff>\n${diff.slice(0, 300_000)}\n</diff>`;
  const opts = repoDir ? { model, cwd: repoDir, tools: ['Read', 'Grep', 'Glob'] as const, maxBudgetUsd: 2 } : { model };
  const reply = await llm.complete(prompt, opts);
  return { ...applyVerdicts(findings, reply.text), turns: reply.turns };
}

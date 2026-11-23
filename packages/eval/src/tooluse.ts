import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASELINE_PROMPT, parseBaselineReply, type BaselineResult } from './baseline.js';
import type { LlmClient } from './llm.js';

/** Baseline prompt + one tool. BASELINE_PROMPT stays byte-identical; this addendum is the only change. */
export const TOOLS_ADDENDUM = `You have one tool, get_context(symbol), which shows where a function, method, class or field is defined and used in this repository at the pull request head: definitions with their body, calls with the calling function, and subclasses. Use it when whether the diff is correct depends on code outside the diff: the definition of something the diff calls or overrides, the callers of something it changes, a base class contract, or other implementations of a changed interface. Look up only what the review needs, then give your answer in the format above.`;

export const CONTEXT_TOOL = 'mcp__ctx__get_context';
const SERVER = fileURLToPath(new URL('../../mcp/dist/context-server.js', import.meta.url));

/** MCP config that starts the context-only server for one checkout at one commit. */
export function writeContextConfig(path: string, repoDir: string, headSha: string, cacheDir: string): void {
  writeFileSync(path, JSON.stringify({ mcpServers: { ctx: { command: process.execPath, args: [SERVER, '--repo', repoDir, '--head', headSha, '--cache', cacheDir] } } }));
}

export async function reviewWithTools(title: string, diff: string, llm: LlmClient, model: string, mcpConfig: string): Promise<BaselineResult & { turns: number }> {
  const prompt = `${BASELINE_PROMPT}\n\n${TOOLS_ADDENDUM}\n\nPR title: ${title}\n\n<diff>\n${diff.slice(0, 300_000)}\n</diff>`;
  const reply = await llm.complete(prompt, { model, mcpConfig, mcpTools: [CONTEXT_TOOL], maxBudgetUsd: 3 });
  return { findings: parseBaselineReply(reply.text), truncated: diff.length > 300_000, raw: reply.text, turns: reply.turns };
}

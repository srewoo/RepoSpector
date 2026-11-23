import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyFeedback, CATEGORIES, feedbackEntry, ReviewRun, RunStateError, specialistPrompt, verifierPrompt } from '@repospector/core';
import { z } from 'zod';
import { GitError, GitRepo } from './git.js';
import { lookupSymbol } from './context.js';
import { exportFeedback, FeedbackError, FeedbackLog, SHARED_FEEDBACK, sharedFeedback } from './feedback.js';
import { defaultCacheDir, GraphService } from './graph/service.js';
import { HostError, ReviewUrlError, runCli, type CliRunner } from './hosts/index.js';
import { postReview } from './post.js';
import { buildPlan } from './plan.js';
import { RunStore, type StoredRun } from './store.js';
import { formatFinal, packForVerifier, referencedFiles } from './views.js';

export const VERSION = '0.7.0';

class ToolError extends Error {}

const RunId = z.string().min(1).max(64);
const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Known errors go back to the agent verbatim; anything else is logged and returned generically. */
async function handle(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    let text = 'internal error; see the server log';
    if (e instanceof RunStateError) text = `${e.code}: ${e.message}`;
    else if (e instanceof GitError || e instanceof ToolError || e instanceof HostError || e instanceof ReviewUrlError || e instanceof FeedbackError) text = e.message;
    else console.error('[repospector] tool failed:', e);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export interface ServerOptions {
  readonly root: string;
  /** Where the code graph is stored; default REPOSPECTOR_CACHE_DIR or ~/.cache/repospector. */
  readonly cacheDir?: string;
  /** How long get_context waits for a graph build before parsing on demand. */
  readonly graphWaitMs?: number;
  /** Runs gh/glab; tests pass a fake. */
  readonly cliRunner?: CliRunner;
}

export async function createServer(opts: ServerOptions): Promise<McpServer> {
  const repo = await GitRepo.open(opts.root);
  const graph = await GraphService.open(repo, opts.cacheDir);
  const feedback = FeedbackLog.forRepo(repo.root, opts.cacheDir ?? defaultCacheDir());
  const store = new RunStore();
  const server = new McpServer({ name: 'repospector', version: VERSION });

  const getRun = (runId: string): StoredRun => {
    const entry = store.get(runId);
    if (!entry) throw new ToolError(`unknown run ${runId}; runs live only as long as this server process`);
    return entry;
  };

  server.registerTool(
    'plan_review',
    {
      description:
        'Start a review of this repo. Diffs head against base, rates risk, and returns the specialists to run and one shared context pack. Default: working tree (including uncommitted and untracked files) against the merge-base with main.',
      inputSchema: {
        base: z.string().max(200).optional().describe('Base ref; default is the merge-base with origin/HEAD, main or master'),
        head: z.string().max(200).optional().describe('Head ref, or "worktree" (default) for uncommitted work'),
        depth: z.enum(['quick', 'standard', 'deep']).optional(),
      },
      annotations: SAFE,
    },
    async ({ base, head, depth }) =>
      handle(async () => {
        const plan = await buildPlan(repo, base, head ?? 'worktree', depth ?? 'standard');
        const run = new ReviewRun(randomUUID(), plan.specialists, plan.source, () => randomUUID());
        store.add({ run, plan });
        // Build the graph for the reviewed commit (HEAD for uncommitted work) in the background.
        if (graph) void (plan.head === 'worktree' ? repo.resolveCommit('HEAD') : Promise.resolve(plan.head)).then((c) => graph.ensure(c)).catch(() => undefined);
        const { source: _source, ...view } = plan;
        return {
          runId: run.id,
          ...view,
          next:
            plan.specialists.length === 0
              ? 'Nothing to review.'
              : 'For each specialist, start a subagent with get_agent_prompt(name) and this context pack; each calls submit_findings (an empty list is fine). Specialists can call get_context(runId, symbol) to see where a function is defined and used. Then call verify_batch.',
        };
      }),
  );

  server.registerTool(
    'get_agent_prompt',
    {
      description: 'Prompt for a specialist reviewer, or for the verifier.',
      inputSchema: { name: z.enum([...CATEGORIES, 'verifier']) },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ name }) => handle(async () => ({ name, prompt: name === 'verifier' ? verifierPrompt() : specialistPrompt(name) })),
  );

  server.registerTool(
    'submit_findings',
    {
      description:
        'Submit one specialist\'s findings. Each is validated; findings citing lines that do not exist are rejected with a reason. Submit an empty list if there are none.',
      inputSchema: { runId: RunId, specialist: z.string().max(32), findings: z.array(z.unknown()).max(50) },
      annotations: SAFE,
    },
    async ({ runId, specialist, findings }) =>
      handle(async () => {
        const { run, plan } = getRun(runId);
        await plan.source.preload(referencedFiles(findings));
        const result = run.submitFindings(specialist, findings);
        return { accepted: result.accepted.map((f) => f.id), rejected: result.rejected, state: run.state() };
      }),
  );

  server.registerTool(
    'verify_batch',
    {
      description:
        'Close the review stage and get every finding with its cited code, for a fresh verifier subagent that did not see the review. The specialists\' reasoning is withheld so the verifier checks the code, not the argument.',
      inputSchema: { runId: RunId },
      annotations: SAFE,
    },
    async ({ runId }) =>
      handle(async () => {
        const { run, plan } = getRun(runId);
        const { batchId, findings } = run.startVerification();
        await plan.source.preload(findings.flatMap((f) => f.evidence.map((e) => e.file)));
        return { batchId, prompt: verifierPrompt(), findings: findings.map((f) => packForVerifier(f, plan.source)) };
      }),
  );

  server.registerTool(
    'finalize',
    {
      description:
        'Apply the verifier\'s verdicts. Refuses unless every finding has exactly one verdict citing code that exists. Returns the kept findings, what was dropped and why, and what was not reviewed.',
      inputSchema: { runId: RunId, batchId: z.string().max(64), verdicts: z.array(z.unknown()).max(500) },
      annotations: SAFE,
    },
    async ({ runId, batchId, verdicts }) =>
      handle(async () => {
        const entry = getRun(runId);
        await entry.plan.source.preload(referencedFiles(verdicts));
        const judged = entry.run.finalize(batchId, verdicts);
        // Team filter: local reactions plus the repo's shared file at the reviewed revision. Demotes, never drops.
        const reactions = [...feedback.read(), ...(await sharedFeedback(entry.plan.source))];
        entry.final = { ...judged, kept: applyFeedback(judged.kept, reactions) };
        return formatFinal(entry.final, entry.plan, entry.run.specialists);
      }),
  );

  server.registerTool(
    'get_context',
    {
      description:
        'Where an identifier is defined and used in the repo at the revision under review: up to 5 definitions with their first 20 lines and 15 uses with 2 lines around each. Text search, so check each match is the same symbol.',
      inputSchema: { runId: RunId, symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,199}$/, 'an identifier such as getUser or get_user') },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ runId, symbol }) =>
      handle(async () => {
        const { plan } = getRun(runId);
        return lookupSymbol(repo, plan.head, plan.source, symbol, { graph, ...(opts.graphWaitMs !== undefined ? { graphWaitMs: opts.graphWaitMs } : {}) });
      }),
  );

  server.registerTool(
    'post_review',
    {
      description:
        'Post a finalized run\'s findings to a GitHub pull request or GitLab merge request as DRAFTS (a pending review, or draft notes) that only the user sees until they publish them, using their own gh or glab login. dryRun defaults to true and only previews; show the preview to the user and call again with dryRun: false only after they confirm. Default selection: verified findings. Refuses if the pull request head is not the reviewed commit. If gh/glab is not installed or logged in, it posts nothing and returns `handoff` (the pending review or draft notes, ready for a GitHub or GitLab MCP tool) with `instructions`; follow them exactly: confirm with the user, check the head commit and existing markers, and never submit or publish.',
      inputSchema: {
        runId: RunId,
        url: z.string().max(500).describe('https URL of the pull request or merge request'),
        findingIds: z.array(z.string().max(64)).max(200).optional().describe('Findings to post; default all verified'),
        includeSuspected: z.boolean().optional().describe('Also post suspected findings when findingIds is not given'),
        dryRun: z.boolean().optional().describe('Default true: preview only'),
        via: z.enum(['auto', 'cli', 'agent']).optional().describe('auto (default): post with gh/glab if logged in, otherwise return the draft for you to post with a GitHub or GitLab MCP server; cli: gh/glab only; agent: always return the draft'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ runId, url, findingIds, includeSuspected, dryRun, via }) =>
      handle(async () => postReview(repo, getRun(runId), { url, findingIds, includeSuspected, dryRun, via }, opts.cliRunner ?? runCli)),
  );

  server.registerTool(
    'record_feedback',
    {
      description:
        'Record the user\'s reaction to a finding from a finalized run: accepted (a real issue) or rejected (noise), with an optional reason. Stored on this machine only. Later reviews demote findings the user rejected, or that resemble 3 or more rejected ones, to suspected (they are never hidden). Record only reactions the user actually gave.',
      inputSchema: { runId: RunId, findingId: z.string().max(64), reaction: z.enum(['accepted', 'rejected']), reason: z.string().max(500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ runId, findingId, reaction, reason }) =>
      handle(async () => {
        const entry = getRun(runId);
        if (!entry.final) throw new ToolError('finalize the run before recording feedback on its findings');
        const finding = entry.final.kept.find((f) => f.id === findingId);
        if (!finding) throw new ToolError(`unknown finding id for this run: ${findingId}`);
        feedback.append(feedbackEntry(finding, reaction, reason ?? '', new Date()));
        return { recorded: { findingId, reaction }, totalLocal: feedback.read().length };
      }),
  );

  server.registerTool(
    'export_feedback',
    {
      description: `Merge this user's recorded feedback into ${SHARED_FEEDBACK} in the working tree so the team can share it by committing the file. Writes only that file. Call only when the user asks to share or export feedback.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => handle(async () => ({ ...exportFeedback(repo.root, feedback.read()), next: 'Commit the file to share it with the team.' })),
  );

  server.registerTool(
    'get_run_state',
    {
      description: 'Current stage of a run and what is still pending.',
      inputSchema: { runId: RunId },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ runId }) => handle(async () => getRun(runId).run.state()),
  );

  return server;
}

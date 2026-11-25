import { randomUUID } from 'node:crypto';
import { applyFeedback, CATEGORIES, ReviewRun, specialistPrompt, verifierPrompt } from '@repospector/core';
import { z } from 'zod';
import { lookupInProvided, lookupSymbol } from '../context.js';
import { sharedFeedback } from '../feedback.js';
import { remoteHistoryKey, type ReviewHistory } from '../history.js';
import { detectLocalChecks } from '../local-checks.js';
import { buildPlan, type ReviewPlan } from '../plan.js';
import { MemorySource } from '../remote/memory-source.js';
import { buildRemotePlan } from '../remote/remote-plan.js';
import { formatFinal, packForVerifier, referencedFiles } from '../views.js';
import type { StoredRun } from '../store.js';
import { handle, RunId, SAFE, ToolError, type ToolContext } from './util.js';

const NEXT =
  'If ticketRefs lists issues or tickets (or the user named one), fetch them with your connected tools and call provide_issues. If localChecks is not empty, show the commands to the user and run only those they approve, then call submit_check_results with their output. Write a short walkthrough and call submit_summary. Then, for each specialist, start a subagent (on the same model as this session) with get_agent_prompt(name), the runId and the context pack (all pages: call get_context_pack for pages 2..contextPackPages); each calls submit_findings (an empty list is fine). If a specialist subagent fails or is stopped, start it once more; if it fails again, call skip_specialist with the reason instead of doing its work. Then call verify_batch.';

/** The plan as the agent sees it: page 1 of the context pack, never the source or the raw diffs. */
function planView(runId: string, plan: ReviewPlan, extra: Record<string, unknown> = {}) {
  const { source: _source, contextPages, remote: _remote, reviewedDiff: _diff, ...view } = plan;
  return {
    runId,
    ...view,
    ...extra,
    contextPack: contextPages[0] ?? '',
    contextPackPages: contextPages.length,
    next: plan.specialists.length === 0 ? 'Nothing to review.' : NEXT,
  };
}

/** History key of a review: the pull/merge request URL, or the local clone and branch. */
export async function historyKey(c: ToolContext, plan: Pick<ReviewPlan, 'remote'>): Promise<string> {
  if (plan.remote) return remoteHistoryKey(plan.remote.url);
  const repo = c.requireRepo();
  const branch = (await repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
  return `local:${repo.root}:${branch}`;
}

function registerPlan(c: ToolContext): void {
  c.server.registerTool(
    'plan_review',
    {
      description:
        'Start a review. With reviewId (from start_pr_review), plans the pull/merge request whose data and files you provided from your GitHub/GitLab MCP tools. Without it, reviews this local git repo: head against base (default: working tree, including uncommitted and untracked files, against the merge-base with main). Returns the specialists to run and the context pack (page 1; get_context_pack for the rest): the diff, plus the code of the functions and classes the diff calls.',
      inputSchema: {
        reviewId: z.string().max(64).optional().describe('From start_pr_review: plan the pull/merge request provided through your MCP tools'),
        base: z.string().max(200).optional().describe('Local only. Base ref; default is the merge-base with origin/HEAD, main or master'),
        head: z.string().max(200).optional().describe('Local only. Head ref, or "worktree" (default) for uncommitted work'),
        depth: z.enum(['quick', 'standard', 'deep']).optional(),
        since: z.string().max(200).optional().describe('Local only. Re-review: only files changed since this commit, or "last" for the last reviewed commit of this branch (see previousReview)'),
      },
      annotations: SAFE,
    },
    async ({ reviewId, base, head, depth, since }) =>
      handle(async () => {
        if (reviewId) {
          const intake = c.intakes.get(reviewId);
          if (!intake) throw new ToolError(`unknown reviewId ${reviewId}; call start_pr_review first`);
          if (c.store.get(reviewId)) throw new ToolError('this review is already planned; continue with its runId (the same id)');
          const plan = await buildRemotePlan(intake, depth ?? 'standard');
          const key = await historyKey(c, plan);
          c.store.add({ run: new ReviewRun(reviewId, plan.specialists, plan.source, () => randomUUID()), plan, historyKey: key });
          return planView(reviewId, plan, { previousReview: previousView(c.history.get(key)) });
        }
        const repo = c.requireRepo();
        const key = await historyKey(c, {});
        const previous = c.history.get(key);
        if (since === 'last' && !previous) throw new ToolError('no earlier review of this branch is remembered; run a full review (omit since)');
        const sinceRef = since === 'last' ? previous?.head : since;
        const plan = await buildPlan(repo, base, head ?? 'worktree', depth ?? 'standard', { graph: c.graph, ...(c.opts.definitionsWaitMs !== undefined ? { waitMs: c.opts.definitionsWaitMs } : {}) }, sinceRef);
        const run = new ReviewRun(randomUUID(), plan.specialists, plan.source, () => randomUUID());
        c.store.add({ run, plan, historyKey: key });
        if (c.graph) void warmGraph(c, plan);
        return planView(run.id, plan, { previousReview: previousView(previous), localChecks: detectLocalChecks(repo.root), localChecksNote: 'These commands run code from the repository. Show each to the user and run only the ones they approve.' });
      }),
  );
}

function registerPack(c: ToolContext): void {
  c.server.registerTool(
    'get_context_pack',
    {
      description: 'One page of a run\'s context pack (page 1 comes with plan_review). Specialists read every page before reviewing.',
      inputSchema: { runId: RunId, page: z.number().int().min(1).max(1000) },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ runId, page }) =>
      handle(async () => {
        const pages = c.getRun(runId).plan.contextPages;
        if (page > pages.length) throw new ToolError(`the context pack has ${pages.length} page(s)`);
        return { page, pages: pages.length, contextPack: pages[page - 1] };
      }),
  );
}

function previousView(p: ReturnType<ReviewHistory['get']>) {
  return p ? { head: p.head, at: p.at, findings: p.findings.length, hint: 'Pass since: "last" (local) or changedSince (pull/merge request) to review only what changed since then.' } : null;
}

/** Builds the reviewed commit's graph in the background so later get_context calls are fast. */
async function warmGraph(c: ToolContext, plan: ReviewPlan): Promise<void> {
  try {
    const commit = plan.head === 'worktree' ? await c.requireRepo().resolveCommit('HEAD') : plan.head;
    await c.graph?.ensure(commit);
  } catch (e) {
    console.error('[repospector] background graph build failed:', (e as Error).message);
  }
}

function registerSpecialists(c: ToolContext): void {
  c.server.registerTool(
    'get_agent_prompt',
    {
      description: 'Prompt for a specialist reviewer, or for the verifier.',
      inputSchema: { name: z.enum([...CATEGORIES, 'verifier']) },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ name }) => handle(async () => ({ name, prompt: name === 'verifier' ? verifierPrompt() : specialistPrompt(name) })),
  );
  c.server.registerTool(
    'submit_findings',
    {
      description:
        "Submit one specialist's findings. Each is validated; findings citing lines that do not exist are rejected with a reason. Submit an empty list if there are none. For a pull/merge request review, every cited file must have been provided (provide_files) first.",
      inputSchema: { runId: RunId, specialist: z.string().max(32), findings: z.array(z.unknown()).max(50) },
      annotations: SAFE,
    },
    async ({ runId, specialist, findings }) =>
      handle(async () => {
        const { run, plan } = c.getRun(runId);
        await plan.source.preload(referencedFiles(findings));
        const result = run.submitFindings(specialist, findings);
        return { accepted: result.accepted.map((f) => f.id), rejected: result.rejected, state: run.state() };
      }),
  );
  c.server.registerTool(
    'skip_specialist',
    {
      description:
        "Record that a specialist could not run (its subagent failed or was stopped, for example by a safety safeguard) so the review can still be verified and finalized. Its area is reported as not reviewed. Use only after the specialist failed; never to skip work, and never do the specialist's review yourself instead.",
      inputSchema: { runId: RunId, specialist: z.enum(CATEGORIES), reason: z.string().min(1).max(300) },
      annotations: SAFE,
    },
    async ({ runId, specialist, reason }) =>
      handle(async () => {
        const { run } = c.getRun(runId);
        run.skipSpecialist(specialist, reason);
        return run.state();
      }),
  );
}

function registerVerify(c: ToolContext): void {
  c.server.registerTool(
    'verify_batch',
    {
      description:
        "Close the review stage and get every finding with its cited code, for a fresh verifier subagent that did not see the review. The specialists' reasoning is withheld so the verifier checks the code, not the argument.",
      inputSchema: { runId: RunId },
      annotations: SAFE,
    },
    async ({ runId }) =>
      handle(async () => {
        const { run, plan } = c.getRun(runId);
        const { batchId, findings } = run.startVerification();
        await plan.source.preload(findings.flatMap((f) => f.evidence.map((e) => e.file)));
        return { batchId, prompt: verifierPrompt(), findings: findings.map((f) => packForVerifier(f, plan.source)) };
      }),
  );
  c.server.registerTool(
    'finalize',
    {
      description:
        "Apply the verifier's verdicts. Refuses unless every finding has exactly one verdict citing code that exists. Returns the kept findings, what was dropped and why, and what was not reviewed.",
      inputSchema: { runId: RunId, batchId: z.string().max(64), verdicts: z.array(z.unknown()).max(500) },
      annotations: SAFE,
    },
    async ({ runId, batchId, verdicts }) =>
      handle(async () => {
        const entry = c.getRun(runId);
        await entry.plan.source.preload(referencedFiles(verdicts));
        const judged = entry.run.finalize(batchId, verdicts);
        // Team filter: local reactions plus the repo's shared file at the reviewed revision. Demotes, never drops.
        const reactions = [...c.feedbackFor(entry.plan).read(), ...(await sharedFeedback(entry.plan.source))];
        entry.final = { ...judged, kept: applyFeedback(judged.kept, reactions) };
        await rememberReview(c, entry);
        return formatFinal(entry.final, entry.plan, entry.run.specialists, entry.run.state().skippedSpecialists, { summary: entry.summary, checks: entry.checks, carried: entry.carried, issues: entry.issues });
      }),
  );
}

/**
 * Carries the previous review's findings in files a re-review did not cover, then remembers this
 * review (its findings plus the carried ones) for the next re-review. A failure here never fails finalize.
 */
async function rememberReview(c: ToolContext, entry: StoredRun): Promise<void> {
  try {
    if (!entry.final || !entry.historyKey) return;
    const previous = c.history.get(entry.historyKey);
    const covered = new Set(entry.plan.incremental?.files ?? []);
    entry.carried = entry.plan.incremental && previous ? previous.findings.filter((f) => !covered.has(f.file)) : [];
    const head = entry.plan.head === 'worktree' ? await c.requireRepo().resolveCommit('HEAD') : entry.plan.head;
    const findings = entry.final.kept.map((f) => ({ id: f.id, file: f.file, startLine: f.startLine, endLine: f.endLine, severity: f.severity, category: f.category, claim: f.claim, status: f.status, fingerprint: f.fingerprint }));
    c.history.remember(entry.historyKey, { head, at: new Date().toISOString(), findings: [...findings, ...entry.carried] });
  } catch (e) {
    console.error('[repospector] could not remember the review:', (e as Error).message);
  }
}

function registerLookup(c: ToolContext): void {
  c.server.registerTool(
    'get_context',
    {
      description:
        'Where an identifier is defined and used at the revision under review: up to 5 definitions with their first 20 lines and 15 uses with 2 lines around each. Local reviews search the whole repo; pull/merge request reviews search only the provided files. Check each match is the same symbol.',
      inputSchema: { runId: RunId, symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,199}$/, 'an identifier such as getUser or get_user') },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ runId, symbol }) =>
      handle(async () => {
        const { plan } = c.getRun(runId);
        if (plan.source instanceof MemorySource) return lookupInProvided(plan.source, symbol);
        return lookupSymbol(c.requireRepo(), plan.head, plan.source, symbol, { graph: c.graph, ...(c.opts.graphWaitMs !== undefined ? { graphWaitMs: c.opts.graphWaitMs } : {}) });
      }),
  );
  c.server.registerTool(
    'get_run_state',
    {
      description: 'Current stage of a run and what is still pending.',
      inputSchema: { runId: RunId },
      annotations: { ...SAFE, idempotentHint: true },
    },
    async ({ runId }) => handle(async () => c.getRun(runId).run.state()),
  );
}

export function registerReviewTools(c: ToolContext): void {
  registerPlan(c);
  registerPack(c);
  registerSpecialists(c);
  registerVerify(c);
  registerLookup(c);
}

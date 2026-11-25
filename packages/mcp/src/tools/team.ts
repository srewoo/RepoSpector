import { feedbackEntry } from '@repospector/core';
import { z } from 'zod';
import { exportFeedback, SHARED_FEEDBACK } from '../feedback.js';
import { runCli } from '../hosts/index.js';
import { postReview } from '../post.js';
import { handle, RunId, ToolError, type ToolContext } from './util.js';

function registerPost(c: ToolContext): void {
  c.server.registerTool(
    'post_review',
    {
      description:
        "Post a finalized run's findings to a GitHub pull request or GitLab merge request as DRAFTS (a pending review, or draft notes) that only the user sees until they publish them. dryRun defaults to true and only previews; show the preview to the user and call again with dryRun: false only after they confirm. Default selection: verified findings. A pull/merge request reviewed through your GitHub/GitLab MCP is posted back through it: the result is `handoff` (the pending review or draft notes) with `instructions` you must follow exactly (confirm with the user, check the head commit and existing markers, never submit or publish). A local review posts with the user's gh/glab login when available, otherwise the same handoff.",
      inputSchema: {
        runId: RunId,
        url: z.string().max(500).describe('https URL of the pull request or merge request'),
        findingIds: z.array(z.string().max(64)).max(200).optional().describe('Findings (f…) and check problems on changed lines (c…) to post; default all verified findings'),
        maxInline: z.number().int().min(1).max(100).optional().describe('Inline comment cap, default 15 (most likely first); the rest are listed in the review body'),
        includeSuspected: z.boolean().optional().describe('Also post suspected findings when findingIds is not given'),
        dryRun: z.boolean().optional().describe('Default true: preview only'),
        via: z.enum(['auto', 'cli', 'agent']).optional().describe('agent: return the draft for your GitHub/GitLab MCP tools (default for pull/merge request reviews); auto: gh/glab if logged in, else agent (default for local reviews); cli: gh/glab only'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ runId, url, findingIds, includeSuspected, dryRun, via, maxInline }) =>
      handle(async () => postReview(c.repo, c.getRun(runId), { url, findingIds: findingIds ? [...new Set(findingIds)] : undefined, includeSuspected, dryRun, via, maxInline }, c.opts.cliRunner ?? runCli)),
  );
}

function registerFeedback(c: ToolContext): void {
  c.server.registerTool(
    'record_feedback',
    {
      description:
        "Record the user's reaction to a finding from a finalized run: accepted (a real issue) or rejected (noise), with an optional reason. Stored on this machine only. Later reviews of the same repository demote findings the user rejected, or that resemble 3 or more rejected ones, to suspected (they are never hidden). Record only reactions the user actually gave.",
      inputSchema: { runId: RunId, findingId: z.string().max(64), reaction: z.enum(['accepted', 'rejected']), reason: z.string().max(500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ runId, findingId, reaction, reason }) =>
      handle(async () => {
        const entry = c.getRun(runId);
        if (!entry.final) throw new ToolError('finalize the run before recording feedback on its findings');
        const finding = entry.final.kept.find((f) => f.id === findingId);
        if (!finding) throw new ToolError(`unknown finding id for this run: ${findingId}`);
        const log = c.feedbackFor(entry.plan);
        log.append(feedbackEntry(finding, reaction, reason ?? '', new Date()));
        return { recorded: { findingId, reaction }, totalLocal: log.read().length };
      }),
  );
  c.server.registerTool(
    'export_feedback',
    {
      description: `Merge this user's recorded feedback for the local repository into ${SHARED_FEEDBACK} in its working tree so the team can share it by committing the file. Writes only that file. Call only when the user asks to share or export feedback. Needs a local clone.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      handle(async () => {
        const repo = c.requireRepo();
        return { ...exportFeedback(repo.root, c.feedbackFor({}).read()), next: 'Commit the file to share it with the team.' };
      }),
  );
}

export function registerTeamTools(c: ToolContext): void {
  registerPost(c);
  registerFeedback(c);
}

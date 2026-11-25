import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { remoteHistoryKey } from '../history.js';
import { parseReviewUrl } from '../hosts/index.js';
import { handle, SAFE, ToolError, type ToolContext } from '../tools/util.js';
import { fetchSteps, fileSteps } from './instructions.js';
import { acceptFiles, definitionNames, neededFiles, normalizePr, type Intake } from './intake.js';
import { MemorySource } from './memory-source.js';

/** Open pull/merge request intakes per server process; the oldest are dropped past this. */
const MAX_INTAKES = 20;
const Sha = z.string().regex(/^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/, 'a full commit id');
const ReviewId = z.string().min(1).max(64);

const ChangedFile = z
  .object({
    path: z.string().min(1).max(1000),
    previousPath: z.string().max(1000).optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    patch: z.string().max(2_000_000).optional(),
  })
  .strict();

const ProvidedFile = z
  .object({
    path: z.string().min(1).max(1000),
    content: z.string().max(3_000_000),
    encoding: z.enum(['utf8', 'base64']).optional(),
    blobSha: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
  })
  .strict();

function getIntake(c: ToolContext, id: string): Intake {
  const intake = c.intakes.get(id);
  if (!intake) throw new ToolError(`unknown reviewId ${id}; call start_pr_review first (reviews live only as long as this server process)`);
  return intake;
}

function addIntake(c: ToolContext, intake: Intake): void {
  c.intakes.set(intake.id, intake);
  while (c.intakes.size > MAX_INTAKES) {
    const oldest = c.intakes.keys().next().value;
    if (oldest === undefined) break;
    c.intakes.delete(oldest);
  }
}

function registerStart(c: ToolContext): void {
  c.server.registerTool(
    'start_pr_review',
    {
      description:
        'Start a review of a GitHub pull request or GitLab merge request by URL, with no local clone needed. RepoSpector cannot reach GitHub or GitLab itself: you fetch the data with your connected GitHub/GitLab MCP server and hand it over (provide_pr, then provide_files), then call plan_review with the reviewId. Returns the reviewId and the exact steps.',
      inputSchema: { url: z.string().max(500).describe('https URL of the pull request or merge request') },
      annotations: SAFE,
    },
    async ({ url }) =>
      handle(async () => {
        const target = parseReviewUrl(url);
        const intake: Intake = { id: randomUUID(), url, target, source: new MemorySource() };
        addIntake(c, intake);
        const previous = c.history.get(remoteHistoryKey(url));
        return {
          reviewId: intake.id,
          target,
          steps: fetchSteps(target),
          previousReview: previous ? { head: previous.head, at: previous.at, findings: previous.findings.length, hint: 'If the head moved, pass changedSince { sha: this head, files changed since it } to provide_pr to review only the new work.' } : null,
          next: 'Fetch the pull request data with your MCP tools, then call provide_pr.',
        };
      }),
  );
}

function registerProvidePr(c: ToolContext): void {
  c.server.registerTool(
    'provide_pr',
    {
      description:
        'Hand over the pull/merge request data you fetched with your GitHub/GitLab MCP tools: head and base commit ids, title, and either the changed files with their patches or the whole unified diff. Returns the files whose head-commit content is needed (needFiles) and the names whose definitions give repository context (definitionNames).',
      inputSchema: {
        reviewId: ReviewId,
        headSha: Sha,
        baseSha: Sha.describe('GitHub base.sha; GitLab diff_refs.base_sha'),
        title: z.string().max(500).optional(),
        body: z.string().max(100_000).optional().describe('Pull request body / merge request description: linked issues and tickets are found in it'),
        changedSince: z
          .object({ sha: Sha, files: z.array(z.string().min(1).max(1000)).max(3000) })
          .strict()
          .optional()
          .describe("Re-review: start_pr_review's previousReview.head and the paths changed since it (your host's compare, or the files of each newer commit). Only those files are reviewed."),
        files: z.array(ChangedFile).max(3000).optional(),
        diff: z.string().max(5_242_880).optional(),
      },
      annotations: SAFE,
    },
    async ({ reviewId, headSha, baseSha, title, body, changedSince, files, diff }) =>
      handle(async () => {
        const intake = getIntake(c, reviewId);
        if (c.store.get(reviewId)) throw new ToolError('this review is already planned; start a new one with start_pr_review');
        intake.pr = normalizePr({ headSha, baseSha, title, body, changedSince, files, diff });
        const needFiles = neededFiles(intake.pr.diff);
        return {
          reviewId,
          headSha: intake.pr.headSha,
          changedFiles: needFiles.length + intake.pr.noPatch.length,
          needFiles,
          noPatch: intake.pr.noPatch,
          definitionNames: definitionNames(intake.pr.diff),
          steps: fileSteps(intake.target, intake.pr.headSha),
        };
      }),
  );
}

function registerProvideFiles(c: ToolContext): void {
  c.server.registerTool(
    'provide_files',
    {
      description:
        'Hand over file contents at the head commit, fetched with your GitHub/GitLab MCP tools: the changed files (needFiles), files holding the definitions the diff calls, and, during the review, any other file a finding cites. Pass content exactly as fetched and the blob id the tool reports; content that does not match it is refused. Secret files (.env, keys) are refused and never sent to a model.',
      inputSchema: { reviewId: ReviewId.describe('The reviewId (also the runId once planned)'), files: z.array(ProvidedFile).min(1).max(50) },
      annotations: SAFE,
    },
    async ({ reviewId, files }) =>
      handle(async () => {
        const intake = getIntake(c, reviewId);
        if (!intake.pr) throw new ToolError('call provide_pr first, so files are checked against the right commit');
        const result = acceptFiles(intake.source, files);
        const missing = neededFiles(intake.pr.diff).filter((p) => !intake.source.has(p));
        return { ...result, stillNeeded: missing, next: missing.length ? 'Provide the files in stillNeeded.' : c.store.get(reviewId) ? 'Files added to the review; findings can now cite them.' : 'All changed files are here. Provide definition files if you found them, then call plan_review with this reviewId.' };
      }),
  );
}

export function registerRemoteTools(c: ToolContext): void {
  registerStart(c);
  registerProvidePr(c);
  registerProvideFiles(c);
}

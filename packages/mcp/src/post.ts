import { buildPostPlan, fromJudged, postableHunks, type JudgedFinding, type PostPlan } from '@repospector/core';
import { cliUnavailable, handoff, requireCli, type Via } from './handoff.js';
import type { GitRepo } from './git.js';
import { hostFor, HostError, parseReviewUrl, type CliRunner } from './hosts/index.js';
import type { StoredRun } from './store.js';

export interface PostArgs {
  readonly url: string;
  readonly findingIds?: readonly string[] | undefined;
  readonly includeSuspected?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  /** auto (default): gh/glab if logged in, else hand the draft to the agent's GitHub/GitLab MCP. */
  readonly via?: Via | undefined;
}

function select(entry: StoredRun, args: PostArgs): JudgedFinding[] {
  if (!entry.final) throw new HostError('finalize the run before posting');
  const kept = entry.final.kept;
  if (args.findingIds?.length) {
    const byId = new Map(kept.map((f) => [f.id, f]));
    const unknown = args.findingIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new HostError(`unknown finding id(s) for this run: ${unknown.join(', ')}`);
    return args.findingIds.map((id) => byId.get(id) as JudgedFinding);
  }
  return kept.filter((f) => f.status === 'verified' || args.includeSuspected === true);
}

/** The commit whose lines the findings refer to; for a working-tree review, HEAD if no reviewed file changed. */
async function reviewedCommit(repo: GitRepo, entry: StoredRun): Promise<string> {
  if (entry.plan.head !== 'worktree') return entry.plan.head;
  const dirty = await repo.dirtyPaths();
  const changed = entry.plan.files.map((f) => f.path).filter((p) => dirty.has(p));
  if (changed.length) {
    throw new HostError(`the review covered uncommitted changes (${changed.slice(0, 5).join(', ')}); commit and push them, then run plan_review again before posting, so comment lines match the pull request`);
  }
  return repo.resolveCommit('HEAD');
}

/**
 * Posts selected findings as drafts (GitHub pending review, GitLab draft notes) on the PR/MR at
 * `url`, through the user's own gh or glab login. dryRun (the default) returns the plan and posts
 * nothing. Findings already on the PR (by fingerprint marker) are skipped.
 */
export async function postReview(repo: GitRepo, entry: StoredRun, args: PostArgs, run: CliRunner) {
  const findings = select(entry, args);
  const target = parseReviewUrl(args.url);
  const via = args.via ?? 'auto';
  if (via === 'cli') await requireCli(target, run);
  const why = via === 'agent' ? 'via "agent" was requested' : via === 'auto' ? await cliUnavailable(target, run) : null;
  if (why) {
    // No host access: the plan is built from the local diff of the reviewed commit; the agent posts it.
    const commit = await reviewedCommit(repo, entry);
    const plan = buildPostPlan(findings.map(fromJudged), postableHunks(await repo.diff(entry.plan.baseSha, commit)), new Set());
    return { target: args.url, selected: findings.length, via: 'agent', why, posted: 0, commitId: commit, ...handoff(target, plan, commit) };
  }
  const host = hostFor(target, run);
  const [commit, info] = await Promise.all([reviewedCommit(repo, entry), host.info()]);
  if (info.headSha !== commit) {
    throw new HostError(`the pull request head ${info.headSha.slice(0, 12)} is not the reviewed commit ${commit.slice(0, 12)}; push the reviewed commit, or run plan_review with head set to the pull request head, then post again`);
  }
  const plan: PostPlan = buildPostPlan(findings.map(fromJudged), await host.hunks(), await host.existingMarkers());
  const base = { target: args.url, selected: findings.length, alreadyPosted: plan.alreadyPosted };
  if (args.dryRun !== false) {
    return { ...base, dryRun: true, wouldPost: { inline: plan.inline.map(({ findingId, path, line }) => ({ findingId, path, line })), inSummary: plan.inSummary, summary: plan.summary }, next: 'Show this to the user. Post only if they confirm, by calling post_review again with dryRun: false.' };
  }
  if (plan.inline.length === 0 && plan.inSummary.length === 0) return { ...base, dryRun: false, posted: 0, note: 'nothing new to post' };
  const res = await host.post(plan, info);
  return { ...base, dryRun: false, posted: res.posted, inSummary: plan.inSummary.length, failed: res.failed, url: res.url, note: target.kind === 'github' ? 'Posted as a pending review: only you can see it until you submit it on GitHub.' : 'Posted as draft notes: only you can see them until you publish them on GitLab.' };
}

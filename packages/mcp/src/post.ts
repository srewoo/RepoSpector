import { buildPostPlan, checksLine, fromJudged, postableHunks, summaryMarkdown, type PostableFinding, type PostOptions, type PostPlan } from '@repospector/core';
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
  /** Inline comment cap (default 15, most likely first); the rest are listed in the review body. */
  readonly maxInline?: number | undefined;
}

type CheckDiag = NonNullable<StoredRun['checks']>['diagnostics'][number];

const fromDiagnostic = (d: CheckDiag): PostableFinding => ({ id: d.id, fingerprint: d.fingerprint, file: d.file, startLine: d.line, endLine: d.line, claim: `${d.source}: ${d.message}`, status: 'verified', tags: ['check', d.level] });

/** Findings (f…) and check problems on changed lines (c…) to post; default: verified findings, most severe first. */
function select(entry: StoredRun, args: PostArgs): PostableFinding[] {
  if (!entry.final) throw new HostError('finalize the run before posting');
  const kept = entry.final.kept;
  if (args.findingIds?.length) {
    const byId = new Map<string, PostableFinding>([...kept.map((f) => [f.id, fromJudged(f)] as const), ...(entry.checks?.diagnostics ?? []).map((d) => [d.id, fromDiagnostic(d)] as const)]);
    const unknown = args.findingIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new HostError(`unknown finding id(s) for this run: ${unknown.join(', ')}`);
    return args.findingIds.map((id) => byId.get(id) as PostableFinding);
  }
  return kept.filter((f) => f.status === 'verified' || args.includeSuspected === true).map(fromJudged);
}

function postOptions(entry: StoredRun, kind: 'github' | 'gitlab', args: PostArgs): PostOptions {
  return {
    flavor: kind,
    ...(args.maxInline !== undefined ? { maxInline: args.maxInline } : {}),
    ...(entry.summary ? { walkthrough: summaryMarkdown(entry.summary) } : {}),
    ...(entry.checks ? { extra: [checksLine(entry.checks.results)] } : {}),
  };
}

/** The commit whose lines the findings refer to; for a working-tree review, HEAD if no reviewed file changed. */
async function reviewedCommit(repo: GitRepo | undefined, entry: StoredRun): Promise<string> {
  if (entry.plan.head !== 'worktree') return entry.plan.head;
  if (!repo) throw new HostError('no local repository for this review');
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
/** A review fetched through the agent's MCP tools may only be posted back to the same pull/merge request. */
function assertSameTarget(entry: StoredRun, url: string): void {
  if (!entry.plan.remote) return;
  const same = JSON.stringify(parseReviewUrl(entry.plan.remote.url)) === JSON.stringify(parseReviewUrl(url));
  if (!same) throw new HostError(`this review is of ${entry.plan.remote.url}; post it there, not to ${url}`);
}

export async function postReview(repo: GitRepo | undefined, entry: StoredRun, args: PostArgs, run: CliRunner) {
  const findings = select(entry, args);
  const target = parseReviewUrl(args.url);
  assertSameTarget(entry, args.url);
  // Reviews fetched through the agent's GitHub/GitLab MCP are posted back through it too.
  const via = args.via ?? (entry.plan.remote ? 'agent' : 'auto');
  if (via === 'cli') await requireCli(target, run);
  const why = via === 'agent' ? 'via "agent" was requested' : via === 'auto' ? await cliUnavailable(target, run) : null;
  if (why) {
    // No host access: the plan is built from the local diff of the reviewed commit; the agent posts it.
    const commit = await reviewedCommit(repo, entry);
    const diff = entry.plan.remote?.diff ?? (repo ? await repo.diff(entry.plan.baseSha, commit) : '');
    const plan = buildPostPlan(findings, postableHunks(diff), new Set(), postOptions(entry, target.kind, args));
    return { target: args.url, selected: findings.length, via: 'agent', why: entry.plan.remote && !args.via ? 'reviews fetched through your GitHub/GitLab MCP are posted through it' : why, posted: 0, commitId: commit, ...handoff(target, plan, commit) };
  }
  const host = hostFor(target, run);
  const [commit, info] = await Promise.all([reviewedCommit(repo, entry), host.info()]);
  if (info.headSha !== commit) {
    throw new HostError(`the pull request head ${info.headSha.slice(0, 12)} is not the reviewed commit ${commit.slice(0, 12)}; push the reviewed commit, or run plan_review with head set to the pull request head, then post again`);
  }
  const plan: PostPlan = buildPostPlan(findings, await host.hunks(), await host.existingMarkers(), postOptions(entry, target.kind, args));
  const base = { target: args.url, selected: findings.length, alreadyPosted: plan.alreadyPosted };
  if (args.dryRun !== false) {
    return { ...base, dryRun: true, wouldPost: { inline: plan.inline.map(({ findingId, path, line }) => ({ findingId, path, line })), inSummary: plan.inSummary, summary: plan.summary }, next: 'Show this to the user. Post only if they confirm, by calling post_review again with dryRun: false.' };
  }
  if (plan.inline.length === 0 && plan.inSummary.length === 0) return { ...base, dryRun: false, posted: 0, note: 'nothing new to post' };
  const res = await host.post(plan, info);
  return { ...base, dryRun: false, posted: res.posted, inSummary: plan.inSummary.length, failed: res.failed, url: res.url, note: target.kind === 'github' ? 'Posted as a pending review: only you can see it until you submit it on GitHub.' : 'Posted as draft notes: only you can see them until you publish them on GitLab.' };
}

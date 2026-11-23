import { HostError, MARKER_RE, type PostPlan, type ReviewTarget } from '@repospector/core';
import type { CliRunner } from './hosts/index.js';

/**
 * When gh/glab is not usable, post_review hands the draft to the agent, which posts it with a GitHub
 * or GitLab MCP server the user has connected. RepoSpector then needs no git credentials at all.
 */
export type Via = 'auto' | 'cli' | 'agent';

/** Null when gh/glab is installed and logged in for this host; otherwise why not. */
export async function cliUnavailable(target: ReviewTarget, run: CliRunner): Promise<string | null> {
  const cmd = target.kind === 'github' ? 'gh' : 'glab';
  try {
    await run(cmd, ['auth', 'status', '--hostname', target.host]);
    return null;
  } catch (e) {
    return `${(e as Error).message.slice(0, 200)} (log in with \`${cmd} auth login --hostname ${target.host}\` to let RepoSpector post itself)`;
  }
}

export async function requireCli(target: ReviewTarget, run: CliRunner): Promise<void> {
  const why = await cliUnavailable(target, run);
  if (why) throw new HostError(`${target.kind === 'github' ? 'gh' : 'glab'} cannot post for ${target.host}: ${why}`);
}

const markerList = (plan: PostPlan): string[] => [...plan.summary.matchAll(MARKER_RE), ...plan.inline.flatMap((c) => [...c.body.matchAll(MARKER_RE)])].map((m) => m[0]);

/** The draft in the shape a GitHub or GitLab MCP tool takes, plus the rules the agent must follow. */
export function handoff(target: ReviewTarget, plan: PostPlan, commitId: string) {
  const markers = markerList(plan);
  const common = [
    'Show the user what will be posted and post only after they confirm.',
    `Check the pull request head commit first. If it is not ${commitId}, stop: the lines would not match. Ask the user to push the reviewed commit or review again.`,
    `Read the existing comments, reviews and drafts on it. Drop any comment whose hidden marker (${markers.length ? markers.slice(0, 3).join(', ') : 'repospector:<id>'}${markers.length > 3 ? ', …' : ''}) is already there, so nothing is posted twice.`,
  ];
  if (target.kind === 'github') {
    return {
      handoff: { kind: 'github-pending-review' as const, host: target.host, owner: target.owner, repo: target.repo, pullNumber: target.number, commitId, body: plan.summary, comments: plan.inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })) },
      instructions: [
        ...common,
        'With the GitHub MCP tools, create a PENDING review on this pull request at commitId with this body, then add each comment at its path, line and side RIGHT. Do not submit the review and do not approve or request changes: it stays a draft that only the user sees until they submit it on GitHub.',
        'If the user already has a pending review on this pull request, stop and ask them to submit or discard it first (GitHub allows one per person).',
      ],
    };
  }
  return {
    handoff: {
      kind: 'gitlab-draft-notes' as const,
      host: target.host,
      project: target.project,
      mergeRequestIid: target.iid,
      commitId,
      notes: [
        ...plan.inline.map((c) => ({ body: c.body, position: { position_type: 'text' as const, new_path: c.path, new_line: c.line } })),
        { body: plan.summary },
      ],
    },
    instructions: [
      ...common,
      "With the GitLab MCP tools, create each note as a DRAFT note on this merge request. For notes with a position, add base_sha, start_sha and head_sha from the merge request's diff_refs, and old_path for renamed files. Do not publish the drafts: only the user sees them until they publish on GitLab.",
    ],
  };
}

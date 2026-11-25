import type { ReviewTarget } from '@repospector/core';

/**
 * What the agent fetches with its own GitHub/GitLab MCP tools. RepoSpector cannot call another MCP
 * server; the agent is the transport, and RepoSpector checks what it is given. Tool names differ
 * between MCP servers, so the steps name the data, with common tool names as examples.
 */
export function fetchSteps(target: ReviewTarget): string[] {
  if (target.kind === 'github') {
    const ref = `${target.owner}/${target.repo}#${target.number}`;
    return [
      `Use your connected GitHub MCP server (host ${target.host}). If none is connected, stop and tell the user to connect one.`,
      `Get pull request ${ref} (e.g. pull_request_read method "get", or get_pull_request): its head commit sha (head.sha), base commit sha (base.sha), title and body (pass as body).`,
      `Get its changed files with patches (e.g. pull_request_read method "get_files", or get_pull_request_files; read every page). Call provide_pr with files: [{ path: filename, previousPath: previous_filename, status: added|modified|removed→deleted|renamed, patch }]. If your tools give the whole diff text instead (method "get_diff"), pass it as diff.`,
    ];
  }
  const ref = `${target.project}!${target.iid}`;
  return [
    `Use your connected GitLab MCP server (host ${target.host}). If none is connected, stop and tell the user to connect one.`,
    `Get merge request ${ref} (e.g. get_merge_request): diff_refs.head_sha, diff_refs.base_sha (pass it as baseSha), title and description (pass as body).`,
    `Get its changes (e.g. get_merge_request_diffs or the changes of get_merge_request; read every page). Call provide_pr with files: [{ path: new_path, previousPath: old_path, status: new_file→added | deleted_file→deleted | renamed_file→renamed | otherwise modified, patch: diff }].`,
  ];
}

export function fileSteps(target: ReviewTarget, headSha: string): string[] {
  const tool = target.kind === 'github' ? 'get_file_contents' : 'get_repository_file';
  return [
    `Fetch each path in needFiles at ref ${headSha} (the head commit, not a branch name) with your MCP tool (e.g. ${tool}). Call provide_files with { path, content exactly as returned, encoding: "base64" if it is base64, blobSha: the blob id the tool reports (GitHub "sha", GitLab "blob_id") }. Send several files per call.`,
    'Repository context: for the names in definitionNames, find where each is defined in this repository (your MCP code search, or the files the diff imports from), fetch those files at the head commit too, and provide them the same way. Skip names that come from libraries. Up to 30 files.',
    'Optional: provide CLAUDE.md, AGENTS.md, REVIEW.md or .RepoSpector/rules.md at the head commit if they exist (team rules).',
    'Then call plan_review with this reviewId.',
  ];
}

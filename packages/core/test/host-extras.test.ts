import { describe, expect, it } from 'vitest';
import { changedSince, ciChecks, linkedIssues, prDetails, rulesAt } from '../src/hosts/extras.js';
import type { ApiClient } from '../src/hosts/types.js';

const GH = { kind: 'github' as const, host: 'github.com', owner: 'acme', repo: 'web', number: 5 };
const GL = { kind: 'gitlab' as const, host: 'gitlab.com', project: 'grp/app', iid: 9 };

/** Answers GETs from a path → body map; records every path asked for. */
function fakeApi(routes: Record<string, unknown>): ApiClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(path) {
      asked.push(path);
      if (!(path in routes)) throw Object.assign(new Error(`404 ${path}`), { status: 404 });
      const v = routes[path];
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async post() {
      throw new Error('read-only');
    },
  };
}

describe('pull request details', () => {
  it('reads head, base, title and body on both hosts', async () => {
    expect(await prDetails(GH, fakeApi({ 'repos/acme/web/pulls/5': { head: { sha: 'h' }, base: { sha: 'b' }, title: 'T', body: null } }))).toEqual({ headSha: 'h', baseSha: 'b', title: 'T', body: '' });
    expect(await prDetails(GL, fakeApi({ 'projects/grp%2Fapp/merge_requests/9': { sha: 'h', diff_refs: { base_sha: 'b' }, title: 'T', description: 'D' } }))).toEqual({ headSha: 'h', baseSha: 'b', title: 'T', body: 'D' });
  });
});

describe('files changed since the last review', () => {
  it('uses GitHub compare only when the new head descends from the old one', async () => {
    const ahead = fakeApi({ 'repos/acme/web/compare/old...new': { status: 'ahead', files: [{ filename: 'a.ts' }, { filename: 'b.ts', previous_filename: 'c.ts' }] } });
    expect(await changedSince(GH, ahead, 'old', 'new')).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const forced = fakeApi({ 'repos/acme/web/compare/old...new': { status: 'diverged', files: [] } });
    expect(await changedSince(GH, forced, 'old', 'new')).toBeNull();
    expect(await changedSince(GH, fakeApi({}), 'old', 'new')).toBeNull();
  });

  it('checks ancestry on GitLab with merge_base before comparing', async () => {
    const routes = { 'projects/grp%2Fapp/repository/merge_base?refs[]=old&refs[]=new': { id: 'old' }, 'projects/grp%2Fapp/repository/compare?from=old&to=new': { diffs: [{ new_path: 'a.ts', old_path: 'a.ts' }] } };
    expect(await changedSince(GL, fakeApi(routes), 'old', 'new')).toEqual(['a.ts', 'a.ts']);
    expect(await changedSince(GL, fakeApi({ ...routes, 'projects/grp%2Fapp/repository/merge_base?refs[]=old&refs[]=new': { id: 'other' } }), 'old', 'new')).toBeNull();
  });
});

describe('CI results', () => {
  it('reads GitHub check runs, their annotations and commit statuses', async () => {
    const api = fakeApi({
      'repos/acme/web/commits/h/check-runs?per_page=100': { check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'failure', output: { title: '2 problems', annotations_count: 1 } }, { id: 2, name: 'test', status: 'in_progress' }] },
      'repos/acme/web/check-runs/1/annotations?per_page=100': [{ path: 'src/a.ts', start_line: 3, annotation_level: 'failure', title: 'no-var', message: 'Unexpected var' }],
      'repos/acme/web/commits/h/status': { statuses: [{ context: 'ci/legacy', state: 'success' }] },
    });
    const checks = await ciChecks(GH, api, 'h');
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(['lint:failed', 'test:pending', 'ci/legacy:passed']);
    expect(checks[0]?.diagnostics).toEqual([{ source: 'lint', file: 'src/a.ts', line: 3, level: 'error', message: 'no-var: Unexpected var' }]);
  });

  it('reads the GitLab pipeline of the head commit and parses failed job logs', async () => {
    const api = fakeApi({
      'projects/grp%2Fapp/merge_requests/9/pipelines': [{ id: 7, sha: 'other' }, { id: 8, sha: 'h' }],
      'projects/grp%2Fapp/pipelines/8/jobs?per_page=100': [{ id: 1, name: 'lint', status: 'failed' }, { id: 2, name: 'build', status: 'success' }],
      'projects/grp%2Fapp/jobs/1/trace': '\u001b[31m/builds/grp/app/src/a.ts:4:2: error bad thing\u001b[0m\n',
    });
    const checks = await ciChecks(GL, api, 'h');
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(['lint:failed', 'build:passed']);
    expect(checks[0]?.diagnostics[0]).toMatchObject({ file: 'src/a.ts', line: 4, message: 'bad thing' });
  });
});

describe('linked issues', () => {
  it('fetches GitHub issues the body references, skips pull requests, lists Jira keys', async () => {
    const api = fakeApi({ 'repos/acme/web/issues/12': { title: 'Bug', body: 'steps', html_url: 'u12' }, 'repos/acme/web/issues/13': { title: 'PR', pull_request: {}, html_url: 'u13' } });
    const r = await linkedIssues(GH, api, { title: 'Fix PAY-1', body: 'Fixes #12, see #13' });
    expect(r.issues).toEqual([{ ref: '#12', title: 'Bug', body: 'steps', url: 'u12' }]);
    expect(r.ticketKeys).toEqual(['PAY-1']);
  });

  it('uses GitLab closes_issues', async () => {
    const api = fakeApi({ 'projects/grp%2Fapp/merge_requests/9/closes_issues': [{ iid: 4, title: 'Feature', description: 'AC', web_url: 'w4' }] });
    expect((await linkedIssues(GL, api, { title: '', body: '' })).issues).toEqual([{ ref: '#4', title: 'Feature', body: 'AC', url: 'w4' }]);
  });
});

describe('team rules', () => {
  it('reads the rules files that exist at a commit', async () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'Use zod.', 'REVIEW.md': '  ' };
    const r = await rulesAt(async (p) => {
      if (p in files) return files[p] as string;
      throw new Error('404');
    }, 'base');
    expect(r).toEqual({ text: '--- CLAUDE.md ---\nUse zod.', files: ['CLAUDE.md'] });
  });
});

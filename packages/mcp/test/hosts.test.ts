import { describe, expect, it } from 'vitest';
import { hostFor, parseReviewUrl, type CliRunner } from '../src/hosts/index.js';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n';

/** Records calls; answers by the first matching route. */
function fakeRunner(routes: [RegExp, unknown][]): CliRunner & { calls: { cmd: string; args: string[]; stdin?: unknown }[] } {
  const calls: { cmd: string; args: string[]; stdin?: unknown }[] = [];
  const runner = async (cmd: 'gh' | 'glab', args: readonly string[], stdin?: string) => {
    calls.push({ cmd, args: [...args], ...(stdin ? { stdin: JSON.parse(stdin) } : {}) });
    const key = `${cmd} ${args.join(' ')}`;
    const hit = routes.find(([re]) => re.test(key));
    if (!hit) throw new Error(`unexpected call: ${key}`);
    return typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
  };
  return Object.assign(runner, { calls });
}

describe('parseReviewUrl', () => {
  it('parses GitHub and GitHub Enterprise PR urls, ignoring tabs and fragments', () => {
    expect(parseReviewUrl('https://github.com/o/r/pull/12/files#diff-1')).toEqual({ kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 12 });
    expect(parseReviewUrl('https://ghe.corp.example/team/svc/pull/3')).toMatchObject({ kind: 'github', host: 'ghe.corp.example' });
  });

  it('parses GitLab and self-managed MR urls with nested groups', () => {
    expect(parseReviewUrl('https://gitlab.com/g/sub/proj/-/merge_requests/7/diffs')).toEqual({ kind: 'gitlab', host: 'gitlab.com', project: 'g/sub/proj', iid: 7 });
  });

  it.each(['http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/x', 'https://evil.com@github.com/o/r/pull/1', 'file:///etc/passwd', 'https://github.com/o/../r/pull/1'])(
    'rejects %s',
    (u) => expect(() => parseReviewUrl(u)).toThrow(/not a GitHub pull request or GitLab merge request URL/),
  );
});

describe('GitHub host', () => {
  const target = parseReviewUrl('https://github.com/o/r/pull/12');
  const routes: [RegExp, unknown][] = [
    [/^gh api --hostname github\.com -H Accept: application\/vnd\.github\.v3\.diff repos\/o\/r\/pulls\/12$/, DIFF],
    [/^gh api --hostname github\.com repos\/o\/r\/pulls\/12$/, { head: { sha: 'abc' }, state: 'open' }],
    [/pulls\/12\/comments/, [[{ body: 'old <!-- repospector:fp-old -->' }]]],
    [/pulls\/12\/reviews\?/, [[{ state: 'COMMENTED', body: 'x' }]]],
    [/--method POST repos\/o\/r\/pulls\/12\/reviews/, { id: 1, html_url: 'https://github.com/o/r/pull/12#pullrequestreview-1', state: 'PENDING' }],
  ];

  it('reads head, postable hunks and existing markers', async () => {
    const host = hostFor(target, fakeRunner(routes));
    expect((await host.info()).headSha).toBe('abc');
    expect((await host.hunks()).get('src/a.ts')).toEqual([[1, 3]]);
    expect(await host.existingMarkers()).toEqual(new Set(['fp-old']));
  });

  it('refuses when the user already has a pending review on the PR', async () => {
    const host = hostFor(target, fakeRunner([[/pulls\/12\/comments/, [[]]], [/pulls\/12\/reviews\?/, [[{ state: 'PENDING', body: '' }]]]]));
    await expect(host.existingMarkers()).rejects.toThrow(/pending review/);
  });

  it('posts one pending review (no event) with inline comments on the right side', async () => {
    const runner = fakeRunner(routes);
    const res = await hostFor(target, runner).post({ inline: [{ findingId: 'f1', path: 'src/a.ts', line: 2, body: 'B' }], inSummary: [], alreadyPosted: [], summary: 'S' }, { headSha: 'abc' });
    const post = runner.calls.find((c) => c.args.includes('POST'));
    expect(post?.stdin).toEqual({ commit_id: 'abc', body: 'S', comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'B' }] });
    expect(post?.stdin).not.toHaveProperty('event');
    expect(res).toMatchObject({ posted: 1, url: expect.stringContaining('pullrequestreview') });
  });
});

describe('GitLab host', () => {
  const target = parseReviewUrl('https://gitlab.example.com/g/p/-/merge_requests/7');
  const enc = 'projects/g%2Fp/merge_requests/7';
  const routes: [RegExp, unknown][] = [
    [new RegExp(`^glab api --hostname gitlab\\.example\\.com ${enc}$`), { sha: 'abc', diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'abc' } }],
    [new RegExp(`${enc}/diffs`), '[{"old_path":"src/a.ts","new_path":"src/a.ts","diff":"@@ -1,2 +1,3 @@\\n a\\n+b\\n c\\n"}]'],
    [new RegExp(`${enc}/draft_notes$`), [{ note: 'd <!-- repospector:fp-draft -->' }]],
    [new RegExp(`${enc}/notes`), '[{"body":"n"}][{"body":"<!-- repospector:fp-note -->"}]'],
    [new RegExp(`--method POST ${enc}/draft_notes`), { id: 9 }],
  ];

  it('reads head, hunks from per-file diffs, and markers from drafts and notes across pages', async () => {
    const host = hostFor(target, fakeRunner(routes));
    expect((await host.info()).headSha).toBe('abc');
    expect((await host.hunks()).get('src/a.ts')).toEqual([[1, 3]]);
    expect(await host.existingMarkers()).toEqual(new Set(['fp-draft', 'fp-note']));
  });

  it('posts draft notes with text positions, plus the summary as a general draft note', async () => {
    const runner = fakeRunner(routes);
    const host = hostFor(target, runner);
    const info = await host.info();
    await host.hunks();
    const res = await host.post({ inline: [{ findingId: 'f1', path: 'src/a.ts', line: 2, body: 'B' }], inSummary: [], alreadyPosted: [], summary: 'S' }, info);
    const posts = runner.calls.filter((c) => c.args.includes('POST')).map((c) => c.stdin);
    expect(posts).toEqual([
      { note: 'B', position: { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'abc', old_path: 'src/a.ts', new_path: 'src/a.ts', new_line: 2 } },
      { note: 'S' },
    ]);
    expect(res).toMatchObject({ posted: 1, url: 'https://gitlab.example.com/g/p/-/merge_requests/7' });
  });
});

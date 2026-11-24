import { describe, expect, it } from 'vitest';
import { fetchClient } from '../src/hosts/fetch-client.js';
import { pages } from '../src/hosts/json.js';
import { GitHubHost } from '../src/hosts/github.js';
import { GitLabHost } from '../src/hosts/gitlab.js';

type Seen = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, { status?: number; body: string; link?: string }>) {
  const seen: Seen[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, init: init ?? {} });
    const r = routes[u];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body, { status: r.status ?? 200, headers: r.link ? { link: r.link } : {} });
  };
  return { impl: impl as typeof fetch, seen };
}

const TOKEN = 'ghp_SECRETSECRETSECRETSECRETSECRETSECRET';

describe('fetchClient', () => {
  it('sends the token as a Bearer header and asks GitHub for a diff when requested', async () => {
    const f = fakeFetch({ 'https://api.github.com/repos/o/r/pulls/1': { body: 'diff --git' } });
    const api = fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl });
    expect(await api.get('repos/o/r/pulls/1', { accept: 'diff' })).toBe('diff --git');
    const h = new Headers(f.seen[0]?.init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(h.get('accept')).toBe('application/vnd.github.v3.diff');
    expect(f.seen[0]?.init.credentials).toBe('omit');
  });

  it('reads one file at a commit: GitHub contents as raw, GitLab raw file, paths encoded', async () => {
    const gh = fakeFetch({ 'https://api.github.com/repos/o/r/contents/src/a%20b/c.ts?ref=abc123': { body: 'export const x = 1;' } });
    const ghHost = new GitHubHost({ host: 'github.com', owner: 'o', repo: 'r', number: 1 }, fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: gh.impl }));
    expect(await ghHost.fileAt('src/a b/c.ts', 'abc123')).toBe('export const x = 1;');
    expect(new Headers(gh.seen[0]?.init.headers).get('accept')).toBe('application/vnd.github.raw');
    const gl = fakeFetch({ 'https://gitlab.example/api/v4/projects/g%2Fp/repository/files/src%2Fc.rb/raw?ref=abc123': { body: 'def x; end' } });
    const glHost = new GitLabHost({ host: 'gitlab.example', project: 'g/p', iid: 1 }, fetchClient({ kind: 'gitlab', base: 'https://gitlab.example/api/v4', fetchImpl: gl.impl }));
    expect(await glHost.fileAt('src/c.rb', 'abc123')).toBe('def x; end');
  });

  it('follows next links on the same origin and returns all pages', async () => {
    const f = fakeFetch({
      'https://gitlab.example/api/v4/projects/1/notes?per_page=100': { body: '[{"body":"a"}]', link: '<https://gitlab.example/api/v4/projects/1/notes?per_page=100&page=2>; rel="next"' },
      'https://gitlab.example/api/v4/projects/1/notes?per_page=100&page=2': { body: '[{"body":"b"}]' },
    });
    const api = fetchClient({ kind: 'gitlab', base: 'https://gitlab.example/api/v4', token: 'glpat-x', fetchImpl: f.impl });
    expect(pages<{ body: string }>(await api.get('projects/1/notes?per_page=100', { paginate: true })).map((n) => n.body)).toEqual(['a', 'b']);
  });

  it('never follows a next link to another origin (the token would go with it)', async () => {
    const f = fakeFetch({ 'https://api.github.com/x': { body: '[1]', link: '<https://evil.example/steal>; rel="next"' } });
    const api = fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl });
    await expect(api.get('x', { paginate: true })).rejects.toThrow(/another origin/);
    expect(f.seen.map((s) => s.url)).toEqual(['https://api.github.com/x']);
  });

  it('caps pagination', async () => {
    const routes: Record<string, { body: string; link?: string }> = {};
    for (let i = 0; i < 100; i++) routes[`https://api.github.com/x${i ? `?page=${i}` : ''}`] = { body: '[1]', link: `<https://api.github.com/x?page=${i + 1}>; rel="next"` };
    const api = fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: fakeFetch(routes).impl, maxPages: 5 });
    await expect(api.get('x', { paginate: true })).rejects.toThrow(/more than 5 pages/);
  });

  it('posts JSON and reports HTTP errors without the token', async () => {
    const f = fakeFetch({ 'https://api.github.com/r': { status: 422, body: '{"message":"Validation Failed"}' } });
    const api = fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: f.impl });
    const err = await api.post('r', { a: 1 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/422.*Validation Failed/);
    expect(String(err)).not.toContain(TOKEN);
    expect(f.seen[0]?.init.method).toBe('POST');
    expect(f.seen[0]?.init.body).toBe('{"a":1}');
    expect(new Headers(f.seen[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('sends no Authorization header when there is no token (public repositories)', async () => {
    const f = fakeFetch({ 'https://api.github.com/x': { body: '{}' } });
    await fetchClient({ kind: 'github', base: 'https://api.github.com', fetchImpl: f.impl }).get('x');
    expect(new Headers(f.seen[0]?.init.headers).has('authorization')).toBe(false);
  });

  it('rejects paths that try to leave the API root', async () => {
    const api = fetchClient({ kind: 'github', base: 'https://api.github.com', token: TOKEN, fetchImpl: fakeFetch({}).impl });
    await expect(api.get('https://evil.example/x')).rejects.toThrow(/relative/);
    await expect(api.get('//evil.example/x')).rejects.toThrow(/relative/);
  });
});

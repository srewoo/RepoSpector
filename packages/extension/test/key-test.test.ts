import { describe, expect, it } from 'vitest';
import { testSecret } from '../src/key-test.js';
import { tokenHelp } from '../src/token-help.js';
import type { HostSetting } from '../src/settings.js';

const hosts: HostSetting[] = [
  { kind: 'github', origin: 'https://github.com' },
  { kind: 'gitlab', origin: 'https://gitlab.example' },
];

function fake(status: number, json: unknown, headers: Record<string, string> = {}, byPath: Record<string, { status: number; json: unknown }> = {}) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url instanceof Request ? url.url : String(url);
    urls.push(u);
    inits.push(init ?? {});
    const hit = Object.entries(byPath).find(([path]) => u.endsWith(path))?.[1];
    return new Response(JSON.stringify(hit ? hit.json : json), { status: hit ? hit.status : status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { impl, urls, inits };
}

describe('testSecret', () => {
  it('checks a GitHub token with one read of /user: names the account and says whether it can post drafts', async () => {
    const f = fake(200, { login: 'octo' }, { 'x-oauth-scopes': 'read:org, repo' });
    expect(await testSecret('host:https://github.com', 'ghp_x', { hosts, fetchImpl: f.impl })).toBe('Token works: signed in as octo. It can post draft reviews (scope repo).');
    expect(f.urls).toEqual(['https://api.github.com/user']);
    // Same safety as the API client: token only in a header, no cookies, no redirects.
    expect(f.inits[0]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(new Headers(f.inits[0]?.headers).get('authorization')).toBe('Bearer ghp_x');
  });

  it('explains what a GitHub token is missing for posting', async () => {
    const pub = fake(200, { login: 'octo' }, { 'x-oauth-scopes': 'public_repo' });
    expect(await testSecret('host:https://github.com', 'ghp_x', { hosts, fetchImpl: pub.impl })).toMatch(/public repositories only.*repo scope/);
    const none = fake(200, { login: 'octo' }, { 'x-oauth-scopes': 'read:user' });
    expect(await testSecret('host:https://github.com', 'ghp_x', { hosts, fetchImpl: none.impl })).toMatch(/cannot post drafts.*repo scope/);
    const fine = fake(200, { login: 'octo' });
    expect(await testSecret('host:https://github.com', 'github_pat_x', { hosts, fetchImpl: fine.impl })).toMatch(/fine-grained.*Pull requests: Read and write/);
  });

  it('checks a GitLab token and its scopes', async () => {
    const f = fake(200, { username: 'sam' }, {}, { '/personal_access_tokens/self': { status: 200, json: { scopes: ['api'] } } });
    expect(await testSecret('host:https://gitlab.example', 'glpat-x', { hosts, fetchImpl: f.impl })).toBe('Token works: signed in as sam. It can post draft notes (scope api).');
    expect(f.urls).toEqual(['https://gitlab.example/api/v4/user', 'https://gitlab.example/api/v4/personal_access_tokens/self']);
    const ro = fake(200, { username: 'sam' }, {}, { '/personal_access_tokens/self': { status: 200, json: { scopes: ['read_api'] } } });
    expect(await testSecret('host:https://gitlab.example', 'glpat-x', { hosts, fetchImpl: ro.impl })).toMatch(/cannot post draft notes.*api scope/);
    const old = fake(200, { username: 'sam' }, {}, { '/personal_access_tokens/self': { status: 404, json: {} } });
    expect(await testSecret('host:https://gitlab.example', 'glpat-x', { hosts, fetchImpl: old.impl })).toMatch(/could not check.*api scope/);
  });

  it('says plainly when a token is rejected', async () => {
    const f = fake(401, { message: 'Bad credentials' });
    await expect(testSecret('host:https://github.com', 'ghp_bad', { hosts, fetchImpl: f.impl })).rejects.toThrow(/rejected/);
  });

  it('checks a model key by listing its models (free), and hands the list on', async () => {
    const f = fake(200, { data: [{ id: 'gpt-6-luna', created: 2 }, { id: 'text-embedding-4', created: 3 }] });
    let got: readonly { id: string }[] = [];
    expect(await testSecret('provider:openai', 'sk-o', { hosts, fetchImpl: f.impl, onModels: (m) => void (got = m) })).toBe('Key works: 1 model available.');
    expect(f.urls).toEqual(['https://api.openai.com/v1/models']);
    expect(got.map((m) => m.id)).toEqual(['gpt-6-luna']);
  });

  it('says plainly when a model key is rejected', async () => {
    const f = fake(401, { error: { message: 'bad key' } });
    await expect(testSecret('provider:anthropic', 'sk-bad', { hosts, fetchImpl: f.impl })).rejects.toThrow(/Anthropic rejected this key/);
  });

  it('links to the token page with the scopes filled in, per host', () => {
    expect(tokenHelp({ kind: 'github', origin: 'https://github.com' })).toMatchObject({ url: 'https://github.com/settings/tokens/new?description=RepoSpector&scopes=repo' });
    expect(tokenHelp({ kind: 'github', origin: 'https://ghe.example' }).url).toBe('https://ghe.example/settings/tokens/new?description=RepoSpector&scopes=repo');
    expect(tokenHelp({ kind: 'gitlab', origin: 'https://gitlab.example' })).toMatchObject({ url: 'https://gitlab.example/-/user_settings/personal_access_tokens?name=RepoSpector&scopes=api' });
    expect(tokenHelp({ kind: 'gitlab', origin: 'https://gitlab.example' }).text).toMatch(/api/);
  });

  it('refuses a token for a host that is no longer configured, without calling anything', async () => {
    const f = fake(200, {});
    await expect(testSecret('host:https://gone.example', 't', { hosts, fetchImpl: f.impl })).rejects.toThrow(/no longer in your hosts/);
    expect(f.urls).toEqual([]);
  });
});

import { fetchClient, HostError } from '@repospector/core';
import { PRESETS } from './providers/presets.js';
import { ProviderError, type ProviderId } from './providers/types.js';
import { apiBase, type HostSetting } from './settings.js';

const PROVIDER_NAMES: Record<Exclude<ProviderId, 'ollama'>, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google' };

/**
 * GitHub reports a classic token's scopes only in a response header, which the API client does not
 * expose, so this one read is made directly, with the client's safety rules: token in a header only,
 * no cookies, no redirects, a timeout. Fine-grained tokens report no scopes (null).
 */
async function githubUser(base: string, token: string, doFetch: typeof fetch): Promise<{ login: string; scopes: string[] | null }> {
  const headers = new Headers({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' });
  const res = await doFetch(`${base}/user`, { headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HostError(`GitHub answered ${res.status}`, res.status);
  const user = (await res.json()) as { login?: string };
  const header = res.headers.get('x-oauth-scopes');
  return { login: user.login ?? 'an unnamed account', scopes: header === null ? null : header.split(',').map((x) => x.trim()).filter(Boolean) };
}

function githubPosting(token: string, scopes: string[] | null): string {
  if (scopes === null || token.startsWith('github_pat_')) return 'This is a fine-grained token, so its permissions cannot be checked in advance: posting drafts needs Pull requests: Read and write on the repositories you review.';
  if (scopes.includes('repo')) return 'It can post draft reviews (scope repo).';
  if (scopes.includes('public_repo')) return 'It can post draft reviews on public repositories only (scope public_repo). For private ones, create a token with the repo scope.';
  return 'It can read public pull requests but cannot post drafts: create a token with the repo scope.';
}

async function gitlabPosting(api: ReturnType<typeof fetchClient>): Promise<string> {
  let scopes: string[];
  try {
    scopes = (JSON.parse(await api.get('personal_access_tokens/self')) as { scopes?: string[] }).scopes ?? [];
  } catch {
    return 'RepoSpector could not check its scopes on this GitLab version; posting draft notes needs the api scope.';
  }
  return scopes.includes('api') ? 'It can post draft notes (scope api).' : 'It can read merge requests but cannot post draft notes: create a token with the api scope.';
}

/**
 * Checks one saved secret with the smallest real request: a git token reads its own user
 * (read-only); a model key sends one short prompt to that provider's cheapest preset model.
 * Returns a sentence for the user; throws an Error whose message says what failed.
 */
export async function testSecret(name: string, value: string, opts: { hosts: readonly HostSetting[]; fetchImpl?: typeof fetch }): Promise<string> {
  if (name.startsWith('host:')) {
    const origin = name.slice('host:'.length);
    const host = opts.hosts.find((h) => h.origin === origin);
    if (!host) throw new Error(`${origin} is no longer in your hosts; add it again or remove this token.`);
    const label = host.kind === 'github' ? 'GitHub' : 'GitLab';
    try {
      if (host.kind === 'github') {
        const { login, scopes } = await githubUser(apiBase(host), value, opts.fetchImpl ?? fetch);
        return `Token works: signed in as ${login}. ${githubPosting(value, scopes)}`;
      }
      const api = fetchClient({ kind: host.kind, base: apiBase(host), token: value, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
      const user = JSON.parse(await api.get('user')) as { username?: string };
      return `Token works: signed in as ${user.username ?? 'an unnamed account'}. ${await gitlabPosting(api)}`;
    } catch (e) {
      if (e instanceof HostError && (e.status === 401 || e.status === 403)) throw new Error(`${label} rejected this token (${e.status}). Create a new one with read access to the repositories you review, then save it again.`);
      throw new Error(`Could not reach ${label}: ${(e as Error).message}`);
    }
  }
  const provider = name.slice('provider:'.length) as Exclude<ProviderId, 'ollama'>;
  if (!(provider in PRESETS)) throw new Error(`Unknown key type: ${name}`);
  const model = PRESETS[provider].low.model;
  // Loaded on demand: provider code (with the Anthropic SDK) is large.
  const { createProvider } = await import('./providers/index.js');
  try {
    const r = await createProvider({ id: provider, apiKey: value, model, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }).complete({
      system: 'Reply with the single word OK.',
      prompt: 'ping',
      maxTokens: 512,
      effort: 'low',
    });
    return `Key works: ${r.model} answered.`;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'auth') throw new Error(`${PROVIDER_NAMES[provider]} rejected this key. Check it was copied in full, then save it again.`);
    throw new Error((e as Error).message);
  }
}

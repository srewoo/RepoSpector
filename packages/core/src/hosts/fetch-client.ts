import { HostError, type ApiClient } from './types.js';

export interface FetchClientOptions {
  readonly kind: 'github' | 'gitlab';
  /** API root, e.g. https://api.github.com, https://ghe.example/api/v3, https://gitlab.example/api/v4 */
  readonly base: string;
  /** Personal access token or OAuth token; sent only to `base`'s origin. Omit for public repositories. */
  readonly token?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly maxPages?: number;
  readonly timeoutMs?: number;
}

const NEXT = /<([^>]+)>;\s*rel="next"/;

/**
 * ApiClient over fetch, for the browser. The token goes in an Authorization header, never a URL;
 * cookies are not sent; pagination follows `Link: rel="next"` only within the API origin.
 */
export function fetchClient(opts: FetchClientOptions): ApiClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = new URL(opts.base).origin;
  const root = opts.base.replace(/\/+$/, '');
  const maxPages = opts.maxPages ?? 50;

  const url = (path: string): string => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path)) throw new HostError('API paths must be relative to the API root');
    return `${root}/${path.replace(/^\/+/, '')}`;
  };

  async function call(target: string, init: RequestInit, accept: string): Promise<Response> {
    if (new URL(target).origin !== origin) throw new HostError('refusing to send the token to another origin');
    const headers = new Headers({ accept });
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
    if (opts.kind === 'github') headers.set('x-github-api-version', '2022-11-28');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const res = await doFetch(target, { ...init, headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      let message = text;
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? text);
      } catch {
        /* not JSON */
      }
      throw new HostError(`${opts.kind === 'github' ? 'GitHub' : 'GitLab'} API ${res.status}: ${message.slice(0, 200)}`, res.status);
    }
    return res;
  }

  const jsonAccept = opts.kind === 'github' ? 'application/vnd.github+json' : 'application/json';

  return {
    async get(path, o = {}) {
      const accept = o.accept === 'diff' ? 'application/vnd.github.v3.diff' : jsonAccept;
      if (!o.paginate) return (await call(url(path), { method: 'GET' }, accept)).text();
      const all: unknown[] = [];
      let next: string | undefined = url(path);
      for (let n = 0; next; n++) {
        if (n >= maxPages) throw new HostError(`more than ${maxPages} pages; stopping`);
        const res: Response = await call(next, { method: 'GET' }, accept);
        all.push(JSON.parse(await res.text()));
        const link = res.headers.get('link')?.match(NEXT)?.[1];
        if (link && new URL(link).origin !== origin) throw new HostError('pagination pointed to another origin; refusing to follow it');
        next = link;
      }
      return JSON.stringify(all);
    },
    async post(path, body) {
      return (await call(url(path), { method: 'POST', body: JSON.stringify(body) }, jsonAccept)).text();
    },
  };
}

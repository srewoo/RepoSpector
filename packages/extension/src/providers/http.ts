import { kindForStatus, ProviderError } from './types.js';

/** POST JSON and parse JSON, mapping failures to ProviderError. Headers carry keys; messages never do. */
export async function postJson(
  fetchImpl: typeof fetch,
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  onNetworkError?: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: signal ?? AbortSignal.timeout(600_000),
    });
  } catch (e) {
    throw new ProviderError('network', `${label}: could not connect (${(e as Error).message})${onNetworkError ? `. ${onNetworkError}` : ''}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown } | string };
      message = String(typeof j.error === 'string' ? j.error : (j.error?.message ?? message));
    } catch {
      /* not JSON */
    }
    throw new ProviderError(kindForStatus(res.status), `${label} ${res.status}: ${message.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('server', `${label}: response was not JSON`);
  }
}

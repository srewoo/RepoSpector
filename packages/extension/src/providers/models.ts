import { OLLAMA_URL } from './ollama.js';
import { kindForStatus, ProviderError, type ProviderId } from './types.js';

/** A model the user's key can call, as the provider lists it. */
export interface ListedModel {
  readonly id: string;
  /** Provider's display name when it has one, else the id. */
  readonly label: string;
}

/** Same rule as the saved setting: ids that cannot alter a URL path or query. Others are dropped. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/**
 * OpenAI lists every model on the account, including ones that cannot review code (embeddings,
 * speech, images, moderation). Excluded by name because OpenAI's list has no capability field.
 */
const OPENAI_NOT_TEXT = /(embedding|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|search|computer-use|babbage|davinci|sora)/i;

interface ListOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const PAGE_CAP = 20;

/** The provider's own error text, if any, with the key removed and the length capped. */
async function errorText(res: Response, secret: string | undefined): Promise<string> {
  let text = '';
  try {
    text = await res.text();
    const j = JSON.parse(text) as { error?: { message?: unknown } | string };
    text = String(typeof j.error === 'string' ? j.error : (j.error?.message ?? text));
  } catch {
    /* not JSON: keep the raw text */
  }
  if (secret) text = text.split(secret).join('[key]');
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Maps a failed list call to what the user should do. 401 = wrong key. 403 = the key is valid but
 * may not list models (OpenAI restricted keys). Gemini answers an invalid key with 400.
 */
function listError(label: string, status: number, detail: string): ProviderError {
  const said = detail ? ` ${label} said: "${detail}"` : '';
  if (status === 401 || (status === 400 && /api[ _]?key/i.test(detail))) return new ProviderError('auth', `${label} rejected this key (${status}). Check that you copied all of it and that it is still active.${said}`);
  if (status === 403) return new ProviderError('auth', `${label} accepted the key but refused to list its models (403). The key may be restricted: allow it to read models, or use a key with full access.${said}`);
  if (status === 429) return new ProviderError('rate_limit', `${label} is rate limiting this key (429). Wait a minute and try again.${said}`);
  if (status >= 500) return new ProviderError('server', `${label} had a server error (${status}). Try again in a few minutes.`);
  return new ProviderError(kindForStatus(status), `${label} answered ${status} when listing models.${said}`);
}

async function getJson(fetchImpl: typeof fetch, label: string, url: string, headers: Record<string, string>, secret?: string, hint?: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ProviderError('network', `Could not reach ${label} (${(e as Error).message}). Check your internet connection${hint ? `. ${hint}` : '.'}`);
  }
  if (!res.ok) throw listError(label, res.status, await errorText(res, secret));
  try {
    return await res.json();
  } catch {
    throw new ProviderError('server', `${label}: the model list was not JSON`);
  }
}

async function anthropic(o: Required<Pick<ListOptions, 'fetchImpl'>> & ListOptions): Promise<ListedModel[]> {
  const headers = { 'x-api-key': o.apiKey ?? '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  const out: ListedModel[] = [];
  let after = '';
  for (let page = 0; page < PAGE_CAP; page++) {
    const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const r = (await getJson(o.fetchImpl, 'Anthropic', url, headers, o.apiKey)) as { data?: { id?: string; display_name?: string }[]; has_more?: boolean; last_id?: string };
    for (const m of r.data ?? []) if (m.id) out.push({ id: m.id, label: m.display_name || m.id });
    if (!r.has_more || !r.last_id) break;
    after = r.last_id;
  }
  return out;
}

async function openai(o: Required<Pick<ListOptions, 'fetchImpl'>> & ListOptions): Promise<ListedModel[]> {
  const r = (await getJson(o.fetchImpl, 'OpenAI', 'https://api.openai.com/v1/models', { authorization: `Bearer ${o.apiKey ?? ''}` }, o.apiKey)) as { data?: { id?: string; created?: number }[] };
  return (r.data ?? [])
    .filter((m): m is { id: string; created?: number } => typeof m.id === 'string' && !OPENAI_NOT_TEXT.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({ id: m.id, label: m.id }));
}

async function gemini(o: Required<Pick<ListOptions, 'fetchImpl'>> & ListOptions): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  let token = '';
  for (let page = 0; page < PAGE_CAP; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const r = (await getJson(o.fetchImpl, 'Gemini', url, { 'x-goog-api-key': o.apiKey ?? '' }, o.apiKey)) as {
      models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    for (const m of r.models ?? []) {
      // Only models that can answer a prompt; this drops embedding, image and answer-only models.
      if (!m.name || !m.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      out.push({ id, label: m.displayName || id });
    }
    if (!r.nextPageToken) break;
    token = r.nextPageToken;
  }
  return out;
}

async function ollama(o: Required<Pick<ListOptions, 'fetchImpl'>> & ListOptions): Promise<ListedModel[]> {
  const base = o.baseUrl ?? OLLAMA_URL;
  const hint = `Check that Ollama is running at ${base} and allows this extension (OLLAMA_ORIGINS=chrome-extension://*).`;
  const r = (await getJson(o.fetchImpl, 'Ollama', `${base}/api/tags`, {}, undefined, hint)) as { models?: { name?: string }[] };
  return (r.models ?? []).flatMap((m) => (m.name ? [{ id: m.name, label: m.name }] : []));
}

const LISTERS = { anthropic, openai, gemini, ollama } as const;

/**
 * Asks the provider which models this key (or local Ollama) can use. Free: no tokens are spent.
 * The key goes only in a header to that provider's own API. Unsafe ids and duplicates are dropped.
 */
export async function listModels(provider: ProviderId, opts: ListOptions = {}): Promise<ListedModel[]> {
  if (provider !== 'ollama' && !opts.apiKey) throw new ProviderError('auth', 'Add an API key first.');
  const listed = await LISTERS[provider]({ ...opts, fetchImpl: opts.fetchImpl ?? fetch });
  const seen = new Set<string>();
  return listed.filter((m) => SAFE_ID.test(m.id) && !seen.has(m.id) && (seen.add(m.id), true));
}

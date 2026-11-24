import { PRESETS, type ModelChoice, type Preset } from './providers/presets.js';
import type { ListedModel } from './providers/models.js';
import type { ProviderId } from './providers/types.js';

/** One entry in the model picker. */
export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Set for the measured presets; they are listed first. */
  readonly recommended?: Preset;
  /** Dated list price, known only for presets. */
  readonly price?: ModelChoice;
}

export interface Catalog {
  readonly entries: readonly CatalogEntry[];
  /** 'provider' = the list came from the user's key; 'presets' = fallback when it could not be fetched. */
  readonly source: 'provider' | 'presets';
  readonly fetchedAt?: number;
}

/** Cached lists are refreshed after a day, and whenever a key is saved or the user asks. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'modelCatalog';
const ORDER: readonly Preset[] = ['balanced', 'best', 'low'];

function presetFor(provider: ProviderId, id: string): Preset | undefined {
  if (provider === 'ollama') return undefined;
  return ORDER.find((p) => PRESETS[provider][p].model === id);
}

/** Dated price of a model id when it is one of the presets, else null (unknown). */
export function priceFor(provider: ProviderId, id: string): ModelChoice | null {
  const p = presetFor(provider, id);
  return p && provider !== 'ollama' ? PRESETS[provider][p] : null;
}

/**
 * Turns the provider's list into picker entries: recommended presets the key can use first
 * (balanced, best, low), then everything else in the provider's order. Presets the key cannot
 * use are left out, because the list is what the key can actually call.
 */
export function buildCatalog(provider: ProviderId, listed: readonly ListedModel[], fetchedAt: number): Catalog {
  const entries = listed.map((m): CatalogEntry => {
    const recommended = presetFor(provider, m.id);
    const price = priceFor(provider, m.id);
    return { id: m.id, label: m.label, ...(recommended ? { recommended } : {}), ...(price ? { price } : {}) };
  });
  const rank = (e: CatalogEntry) => (e.recommended ? ORDER.indexOf(e.recommended) : ORDER.length);
  // Array.prototype.sort is stable, so non-presets keep the provider's order.
  return { entries: [...entries].sort((a, b) => rank(a) - rank(b)), source: 'provider', fetchedAt };
}

interface Stored {
  readonly fetchedAt: number;
  readonly models: readonly ListedModel[];
}

function isStored(v: unknown): v is Stored {
  const s = v as Stored | undefined;
  return !!s && typeof s.fetchedAt === 'number' && Array.isArray(s.models) && s.models.every((m) => typeof m?.id === 'string' && typeof m?.label === 'string');
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

/** The cached list for a provider, or null when there is none or it is older than the TTL. */
export async function cachedCatalog(area: Area, provider: ProviderId, now = Date.now()): Promise<Catalog | null> {
  const all = ((await area.get(STORAGE_KEY))[STORAGE_KEY] ?? {}) as Record<string, unknown>;
  const hit = all[provider];
  if (!isStored(hit) || now - hit.fetchedAt > CATALOG_TTL_MS) return null;
  return buildCatalog(provider, hit.models, hit.fetchedAt);
}

/** Saves a fresh list. Only model ids and names are stored, never the key. */
export async function saveCatalog(area: Area, provider: ProviderId, models: readonly ListedModel[], now = Date.now()): Promise<Catalog> {
  const all = ((await area.get(STORAGE_KEY))[STORAGE_KEY] ?? {}) as Record<string, unknown>;
  await area.set({ [STORAGE_KEY]: { ...all, [provider]: { fetchedAt: now, models } } });
  return buildCatalog(provider, models, now);
}

/** Drops a provider's cached list, e.g. when its key is removed. */
export async function forgetCatalog(area: Area, provider: ProviderId): Promise<void> {
  const all = { ...(((await area.get(STORAGE_KEY))[STORAGE_KEY] ?? {}) as Record<string, unknown>) };
  delete all[provider];
  await area.set({ [STORAGE_KEY]: all });
}

/** Picker text, e.g. "claude-sonnet-5-5 · Recommended: balanced · $2 / $10 per M tokens". */
export function entryText(e: CatalogEntry): string {
  const name = e.label === e.id ? e.id : `${e.label} (${e.id})`;
  const rec = e.recommended ? ` · Recommended: ${e.recommended === 'best' ? 'best accuracy' : e.recommended === 'low' ? 'low cost' : 'balanced'}` : '';
  const price = e.price ? ` · $${e.price.inPerM} in / $${e.price.outPerM} out per M tokens` : '';
  return `${name}${rec}${price}`;
}

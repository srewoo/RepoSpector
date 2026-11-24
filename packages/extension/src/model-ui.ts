import { button, el } from './dom.js';
import { hasProviderKey, providerKey } from './key-entry.js';
import { cachedCatalog, entryText, forgetCatalog, saveCatalog, type Catalog } from './model-catalog.js';
import { ModelSettingsSchema, providerOrigins, type ModelSettings } from './model-settings.js';
import { vault } from './keys-ui.js';
import { listModels, type ListedModel } from './providers/models.js';
import { PRESETS, PRICES_AS_OF, type Preset } from './providers/presets.js';
import type { ProviderId } from './providers/types.js';
import { message, statusLine } from './secret-ui.js';

const LABELS: Record<ProviderId, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama (runs on this computer, free)' };
const NAME: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google', ollama: 'Ollama' };
const KEY_PAGES: Record<Exclude<ProviderId, 'ollama'>, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};
const OTHER = '__other';

/** The saved model, or null when the user has not chosen one yet. */
export async function savedModelSettings(): Promise<ModelSettings | null> {
  const { model } = await chrome.storage.local.get('model');
  const parsed = ModelSettingsSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

export async function loadModelSettings(): Promise<ModelSettings> {
  return (await savedModelSettings()) ?? { provider: 'anthropic', preset: 'balanced' };
}

function presetOf(id: ProviderId, model: string): Preset {
  if (id === 'ollama') return 'balanced';
  return (['best', 'balanced', 'low'] as const).find((p) => PRESETS[id][p].model === model) ?? 'balanced';
}

function settingsFor(id: ProviderId, model: string, ollamaUrl: string): ModelSettings | null {
  const parsed = ModelSettingsSchema.safeParse({
    provider: id,
    preset: presetOf(id, model),
    ...(id === 'ollama' ? { ollamaModel: model } : { customModel: model }),
    ...(id === 'ollama' && ollamaUrl ? { ollamaUrl } : {}),
  });
  return parsed.success ? parsed.data : null;
}

interface Ctx {
  readonly id: ProviderId;
  readonly say: (t: string) => void;
  readonly ollamaUrl: () => string;
  readonly redraw: () => void;
}

/**
 * Saves the fresh list. When no model was chosen yet, the first entry (the recommended one when the
 * key can use it) is saved too, so reviews work straight away. Returns the sentence to show.
 */
async function adoptList(c: Ctx, models: readonly ListedModel[]): Promise<string> {
  const catalog = await saveCatalog(chrome.storage.local, c.id, models);
  const found = `${c.id === 'ollama' ? 'Connected' : 'Key works'}: ${models.length} model${models.length === 1 ? '' : 's'} available.`;
  const first = catalog.entries[0];
  const current = await savedModelSettings();
  if (!current && first) {
    const s = settingsFor(c.id, first.id, c.ollamaUrl());
    if (s) {
      await chrome.storage.local.set({ model: s });
      c.say(`${found} Reviews will use ${first.id}${first.recommended ? ' (recommended)' : ''}; you can pick another in step 1.`);
      return found;
    }
  }
  c.say(current?.provider === c.id ? found : `${found} Pick a model in step 1 and press Save model to review with ${NAME[c.id]}.`);
  return found;
}

/** Dropdown of the models this key (or Ollama install) can use; recommended first. */
async function picker(c: Ctx, catalog: Catalog): Promise<Node[]> {
  const saved = await savedModelSettings();
  const current = saved?.provider === c.id ? (c.id === 'ollama' ? saved.ollamaModel : (saved.customModel ?? PRESETS[c.id][saved.preset].model)) : undefined;
  const pick = el('select', { id: 'model-pick', name: 'model-pick' });
  for (const e of catalog.entries) pick.append(el('option', { value: e.id, textContent: entryText(e) }));
  pick.append(el('option', { value: OTHER, textContent: 'Other: type a model id' }));
  const known = !!current && catalog.entries.some((e) => e.id === current);
  pick.value = known ? (current as string) : current ? OTHER : (catalog.entries[0]?.id ?? OTHER);
  const other = el('input', { id: 'model-other', name: 'model-other', autocomplete: 'off', placeholder: 'model id', value: known ? '' : (current ?? '') });
  const otherLabel = el('label', { htmlFor: 'model-other', textContent: 'Model id' });
  const price = el('p', { className: 'muted' });
  const sync = (): void => {
    other.hidden = otherLabel.hidden = pick.value !== OTHER;
    const entry = catalog.entries.find((e) => e.id === pick.value);
    price.textContent = c.id === 'ollama' ? 'Runs on this computer; no model cost.' : entry?.price ? `Prices as listed by ${NAME[c.id]} on ${PRICES_AS_OF}; they change.` : 'Price not listed in RepoSpector: the cost estimate will show token counts only.';
  };
  pick.addEventListener('change', sync);
  sync();
  const when = catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleString() : '';
  const source = el('p', { className: 'muted', textContent: `Only models your ${c.id === 'ollama' ? 'Ollama install has' : 'key can use'} are listed (checked ${when}). Recommended ones come first.` });
  const using = el('p', { textContent: saved?.provider === c.id && current ? `Reviews use ${current}.` : `Reviews currently use ${saved ? NAME[saved.provider] : 'no model yet'}; save a model here to switch to ${NAME[c.id]}.` });
  const status = statusLine('model-status');
  const save = button('Save model', () => {
    const model = pick.value === OTHER ? other.value.trim() : pick.value;
    const s = model ? settingsFor(c.id, model, c.ollamaUrl()) : null;
    if (!s) return status.error('Choose a model. Model ids may contain only letters, digits and . _ : -');
    // permissions.request must run in the click's user gesture, before any other await.
    chrome.permissions.request({ origins: providerOrigins(c.id) }).then(async (granted) => {
      if (!granted) return status.error(`Chrome permission for ${NAME[c.id]} was not granted, so the model was not saved.`);
      await chrome.storage.local.set({ model: s });
      c.say(`Saved: reviews will use ${model} from ${NAME[c.id]}.`);
      c.redraw();
    }, (e: unknown) => status.error(message(e)));
  }, true);
  return [el('label', { htmlFor: 'model-pick', textContent: 'Model' }), pick, otherLabel, other, source, price, using, el('div', { className: 'actions' }, save), status.node];
}

/** Loads the list for a saved key whose list is not cached (expired, or another device's settings). */
function loader(c: Ctx, auto: boolean): Node[] {
  const status = statusLine('model-status');
  const fetchList = async (): Promise<void> => {
    const key = await vault.getSecret(`provider:${c.id}`);
    await adoptList(c, await listModels(c.id, key ? { apiKey: key } : {}));
    c.redraw();
  };
  const fail = (e: unknown): void => status.error(message(e));
  const load = button('Load models', () => {
    status.busy(`Loading the models your ${NAME[c.id]} key can use…`);
    // permissions.request must be the first await, inside the click.
    chrome.permissions
      .request({ origins: providerOrigins(c.id) })
      .then(async (granted) => {
        if (!granted) throw new Error(`Chrome permission to reach ${NAME[c.id]} was not granted.`);
        await fetchList();
      })
      .catch(fail);
  });
  // Already allowed: load straight away, no click needed.
  if (auto) {
    status.busy(`Loading the models your ${NAME[c.id]} key can use…`);
    void fetchList().catch(fail);
  }
  return [el('label', { textContent: 'Model' }), el('div', { className: 'actions' }, load), status.node];
}

async function modelBlock(c: Ctx, autoLoad: boolean): Promise<Node[]> {
  const cached = await cachedCatalog(chrome.storage.local, c.id);
  if (c.id === 'ollama') return cached ? picker(c, cached) : [el('p', { className: 'muted', textContent: 'Press Check connection to load the models you have pulled.' })];
  if (!(await hasProviderKey(c.id))) return [el('p', { className: 'muted', textContent: 'Your models appear here once your key is checked: only the ones this key can use.' })];
  if (cached) return picker(c, cached);
  return loader(c, autoLoad && (await chrome.permissions.contains({ origins: providerOrigins(c.id) })));
}

/** Ollama: the local address and a connection check that loads the pulled models. */
function ollamaBlock(c: Ctx, input: HTMLInputElement): Node[] {
  const status = statusLine('ollama-status');
  const go = button('Check connection and load models', () => {
    status.busy('Connecting to Ollama…');
    chrome.permissions
      .request({ origins: providerOrigins('ollama') })
      .then(async (granted) => {
        if (!granted) throw new Error('Chrome permission to reach localhost was not granted.');
        const url = c.ollamaUrl();
        const models = await listModels('ollama', url ? { baseUrl: url } : {});
        if (models.length === 0) throw new Error('Ollama is running but has no models. Pull one first, for example: ollama pull qwen3:32b');
        status.ok(await adoptList(c, models));
        c.redraw();
      })
      .catch((e: unknown) => status.error(message(e)));
  }, true);
  return [
    el('label', { htmlFor: 'ollamaUrl', textContent: 'Ollama address' }),
    input,
    el('p', { className: 'muted' }, 'Ollama must allow this extension: start it with ', el('code', { textContent: 'OLLAMA_ORIGINS=chrome-extension://*' }), '.'),
    el('div', { className: 'actions' }, go),
    status.node,
  ];
}

/** Step 1: provider, the user's own API key (checked before it is saved), and a model from what that key can use. */
export async function renderModel(root: HTMLElement, say: (t: string) => void, vaultChanged: () => void = () => undefined): Promise<void> {
  const saved = await savedModelSettings();
  const provider = el('select', { id: 'provider', name: 'provider' });
  for (const id of Object.keys(LABELS) as ProviderId[]) provider.append(el('option', { value: id, textContent: LABELS[id], selected: id === (saved?.provider ?? 'anthropic') }));
  const ollamaUrl = el('input', { id: 'ollamaUrl', name: 'ollamaUrl', placeholder: 'http://localhost:11434', autocomplete: 'off', inputMode: 'url', value: saved?.ollamaUrl ?? '' });
  const keyBox = el('div');
  const modelBox = el('div');
  root.replaceChildren(el('label', { htmlFor: 'provider', textContent: 'AI provider' }), provider, keyBox, modelBox);

  let gen = 0; // a newer draw (provider changed) wins over a slower older one
  const draw = async (autoLoad: boolean): Promise<void> => {
    const g = ++gen;
    const id = provider.value as ProviderId;
    const c: Ctx = { id, say, ollamaUrl: () => ollamaUrl.value.trim().replace(/\/+$/, ''), redraw: () => void draw(false) };
    const keyNodes =
      id === 'ollama'
        ? ollamaBlock(c, ollamaUrl)
        : await providerKey({
            id,
            name: NAME[id],
            keyPage: KEY_PAGES[id],
            origins: providerOrigins(id),
            onKeySaved: (models) => adoptList(c, models),
            onRechecked: async (models) => void (await saveCatalog(chrome.storage.local, id, models)),
            onRemoved: async () => (await forgetCatalog(chrome.storage.local, id), say(`Removed the ${NAME[id]} API key.`)),
            vaultChanged,
            redraw: c.redraw,
          });
    const modelNodes = await modelBlock(c, autoLoad);
    if (g !== gen) return;
    keyBox.replaceChildren(...keyNodes);
    modelBox.replaceChildren(...modelNodes);
  };
  provider.addEventListener('change', () => void draw(true));
  await draw(true);
}

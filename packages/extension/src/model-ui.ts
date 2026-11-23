import { ModelSettingsSchema, providerOrigins, resolveModel, type ModelSettings } from './model-settings.js';
import { PRESETS, PRICES_AS_OF } from './providers/presets.js';
import { ProviderError, type ProviderId } from './providers/types.js';
import { Vault } from './vault.js';

const LABELS: Record<ProviderId, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama (local, free)' };
const PRESET_LABELS = { best: 'Best accuracy', balanced: 'Balanced', low: 'Low cost' } as const;

export async function loadModelSettings(): Promise<ModelSettings> {
  const { model } = await chrome.storage.local.get('model');
  const parsed = ModelSettingsSchema.safeParse(model);
  return parsed.success ? parsed.data : { provider: 'anthropic', preset: 'balanced' };
}

function option(value: string, text: string, selected: boolean): HTMLOptionElement {
  return Object.assign(document.createElement('option'), { value, textContent: text, selected });
}

/** Provider + preset picker, with a test call that uses the key from the vault. */
export async function renderModel(root: HTMLElement, say: (t: string) => void): Promise<void> {
  const current = await loadModelSettings();
  const form = document.createElement('form');
  form.innerHTML = `
    <label for="provider">Provider</label><select id="provider" name="provider"></select>
    <label for="preset">Preset</label><select id="preset" name="preset"></select>
    <p class="muted" id="price"></p>
    <label for="customModel">Custom model id (optional, advanced)</label><input id="customModel" name="customModel" autocomplete="off">
    <label for="ollamaModel">Ollama model</label><input id="ollamaModel" name="ollamaModel" placeholder="qwen3:32b" autocomplete="off">
    <label for="ollamaUrl">Ollama address</label><input id="ollamaUrl" name="ollamaUrl" placeholder="http://localhost:11434" autocomplete="off" inputmode="url">
    <p class="muted" id="ollama-hint">Ollama must allow this extension: start it with <code>OLLAMA_ORIGINS=chrome-extension://*</code> (check Ollama's documentation on allowed origins).</p>
    <div class="actions"><button type="submit" class="primary">Save model</button> <button type="button" id="test">Test this model</button></div>`;
  root.replaceChildren(form);
  const provider = form.querySelector('#provider') as HTMLSelectElement;
  const preset = form.querySelector('#preset') as HTMLSelectElement;
  const custom = form.querySelector('#customModel') as HTMLInputElement;
  const ollama = form.querySelector('#ollamaModel') as HTMLInputElement;
  const ollamaUrl = form.querySelector('#ollamaUrl') as HTMLInputElement;
  for (const id of Object.keys(LABELS) as ProviderId[]) provider.append(option(id, LABELS[id], id === current.provider));
  custom.value = current.customModel ?? '';
  ollama.value = current.ollamaModel ?? '';
  ollamaUrl.value = current.ollamaUrl ?? '';

  const sync = () => {
    const id = provider.value as ProviderId;
    preset.replaceChildren(
      ...(['best', 'balanced', 'low'] as const).map((p) => {
        const c = id === 'ollama' ? null : PRESETS[id][p];
        return option(p, c ? `${PRESET_LABELS[p]}: ${c.model}, $${c.inPerM} in / $${c.outPerM} out per million tokens` : PRESET_LABELS[p], p === current.preset);
      }),
    );
    const isOllama = id === 'ollama';
    preset.disabled = isOllama;
    custom.disabled = isOllama;
    ollama.parentElement?.querySelectorAll('#ollamaModel, label[for="ollamaModel"], #ollamaUrl, label[for="ollamaUrl"], #ollama-hint').forEach((n) => ((n as HTMLElement).hidden = !isOllama));
    (form.querySelector('#price') as HTMLElement).textContent = isOllama ? 'Runs on this machine; no model cost.' : `Prices as listed by the provider on ${PRICES_AS_OF}; they change.`;
  };
  provider.addEventListener('change', sync);
  sync();

  const read = (): ModelSettings | string => {
    const parsed = ModelSettingsSchema.safeParse({
      provider: provider.value,
      preset: preset.value,
      ...(custom.value.trim() ? { customModel: custom.value.trim() } : {}),
      ...(ollama.value.trim() ? { ollamaModel: ollama.value.trim() } : {}),
      ...(ollamaUrl.value.trim() ? { ollamaUrl: ollamaUrl.value.trim().replace(/\/+$/, '') } : {}),
    });
    return parsed.success ? parsed.data : 'Check the fields: model ids may contain only letters, digits and . _ : -, and the Ollama address must look like http://localhost:11434.';
  };

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const s = read();
    if (typeof s === 'string') return say(s);
    // permissions.request must run in the click's user gesture, before any other await.
    chrome.permissions.request({ origins: providerOrigins(s.provider) }).then(async (granted) => {
      if (!granted) return say(`Chrome permission for ${LABELS[s.provider]} was not granted, so the model was not saved.`);
      await chrome.storage.local.set({ model: s });
      say(`Saved: reviews will use ${resolveModel(s).model} from ${LABELS[s.provider]}.`);
    }, (e: unknown) => say(`Could not request permission: ${(e as Error).message}`));
  });

  (form.querySelector('#test') as HTMLButtonElement).addEventListener('click', () => {
    const s = read();
    if (typeof s === 'string') return say(s);
    void (async () => {
      try {
        const { model } = resolveModel(s);
        const apiKey = s.provider === 'ollama' ? undefined : await new Vault(chrome.storage.local, chrome.storage.session).getSecret(`provider:${s.provider}`);
        if (s.provider !== 'ollama' && !apiKey) return say(`Add your ${LABELS[s.provider]} key under Keys and access tokens first, then test again.`);
        say('Testing…');
        // Loaded on demand: the provider code (with the Anthropic SDK) is large and only needed here.
        const { createProvider } = await import('./providers/index.js');
        const p = s.provider === 'ollama' ? createProvider({ id: 'ollama', model, ...(s.ollamaUrl ? { baseUrl: s.ollamaUrl } : {}) }) : createProvider({ id: s.provider, apiKey: apiKey ?? '', model });
        const r = await p.complete({ system: 'Reply with the single word OK.', prompt: 'ping', maxTokens: 512, effort: 'low' });
        say(`The model works: ${r.model} answered, using ${r.usage.inputTokens} input and ${r.usage.outputTokens} output tokens.`);
      } catch (e) {
        say(e instanceof ProviderError ? e.message : `Test failed: ${(e as Error).message}`);
      }
    })();
  });
}

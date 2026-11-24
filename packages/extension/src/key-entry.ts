import { button, el } from './dom.js';
import { canUseSecrets, vault } from './keys-ui.js';
import { listModels, type ListedModel } from './providers/models.js';
import type { ProviderId } from './providers/types.js';
import { message, protection, statusLine, unlockBlock } from './secret-ui.js';

type CloudId = Exclude<ProviderId, 'ollama'>;

export interface KeyCtx {
  readonly id: CloudId;
  /** e.g. "OpenAI" */
  readonly name: string;
  readonly keyPage: string;
  readonly origins: string[];
  /** Runs after a key checked out and was saved, with the models it can use. Returns the sentence to show. */
  readonly onKeySaved: (models: readonly ListedModel[]) => Promise<string>;
  /** Runs after a saved key was checked again. */
  readonly onRechecked: (models: readonly ListedModel[]) => Promise<void>;
  readonly onRemoved: () => Promise<void>;
  /** Vault created, unlocked: other sections re-render. */
  readonly vaultChanged: () => void;
  readonly redraw: () => void;
}

const secretName = (id: CloudId): string => `provider:${id}`;
/** Last check result per provider, kept while the settings page is open. */
const lastCheck = new Map<CloudId, string>();
/** Providers whose saved key the user chose to replace (shows the form again). */
const replacing = new Set<CloudId>();

/** Lists models with this key: free, read-only, and proves the key works. Throws a sentence when it does not. */
async function check(c: KeyCtx, key: string): Promise<readonly ListedModel[]> {
  const models = await listModels(c.id, { apiKey: key });
  if (models.length === 0) throw new Error(`${c.name} accepted this key, but it has no models RepoSpector can use for reviews. Check the key's project or permissions.`);
  return models;
}

function keyForm(c: KeyCtx, firstTime: boolean): Node[] {
  const input = el('input', { id: 'api-key', name: 'api-key', type: 'password', autocomplete: 'off', placeholder: 'Paste your API key' });
  input.setAttribute('aria-describedby', 'api-key-help api-key-status');
  const help = el('p', { className: 'muted', id: 'api-key-help' }, 'RepoSpector uses your own key: you pay the provider directly, and the key is sent only to them. No key yet? ', el('a', { href: c.keyPage, target: '_blank', rel: 'noopener noreferrer', textContent: `Create one on ${c.name}'s site` }), '.');
  const protect = protection(firstTime ? 'none' : 'unlocked', 'key');
  const status = statusLine('api-key-status');
  const save = button('Check and save key', () => {
    const value = input.value.trim();
    if (!value) return status.error(`Paste your ${c.name} API key first.`);
    const problem = protect.validate();
    if (problem) return status.error(problem);
    save.disabled = true;
    status.busy(`Checking the key with ${c.name}…`);
    // permissions.request must be the first await so it stays inside the click's user gesture.
    chrome.permissions
      .request({ origins: c.origins })
      .then(async (granted) => {
        if (!granted) throw new Error(`Chrome permission to reach ${c.name} was not granted, so the key could not be checked. Press the button again and choose Allow.`);
        const models = await check(c, value);
        // Only a key that works is stored.
        const created = await protect.ensure();
        await vault.setSecret(secretName(c.id), value);
        replacing.delete(c.id);
        lastCheck.set(c.id, await c.onKeySaved(models));
        if (created) c.vaultChanged();
        c.redraw();
      })
      .catch((e: unknown) => {
        status.error(`${message(e)} The key was not saved.`);
        save.disabled = false;
      });
  }, true);
  const cancel = replacing.has(c.id) ? [button('Cancel', () => (replacing.delete(c.id), c.redraw()))] : [];
  return [el('label', { htmlFor: 'api-key', textContent: `${c.name} API key` }), input, help, ...protect.nodes, el('div', { className: 'actions' }, save, ...cancel), status.node];
}

function savedRow(c: KeyCtx): Node[] {
  const status = statusLine('api-key-status');
  const last = lastCheck.get(c.id);
  if (last) status.ok(last);
  const again = button('Check again', () => {
    again.disabled = true;
    status.busy(`Checking the key with ${c.name}…`);
    chrome.permissions
      .request({ origins: c.origins })
      .then(async (granted) => {
        if (!granted) throw new Error(`Chrome permission to reach ${c.name} was not granted.`);
        const key = await vault.getSecret(secretName(c.id));
        if (!key) throw new Error('This key is no longer saved.');
        const models = await check(c, key);
        await c.onRechecked(models);
        lastCheck.set(c.id, `Key works: ${models.length} model${models.length === 1 ? '' : 's'} available.`);
        c.redraw();
      })
      .catch((e: unknown) => {
        lastCheck.delete(c.id);
        status.error(`${message(e)} Replace the key if it was revoked.`);
        again.disabled = false;
      });
  });
  again.title = 'Lists the models this key can use. Free: no tokens are spent.';
  const replace = button('Replace key', () => (replacing.add(c.id), c.redraw()));
  const remove = button('Remove key', () => {
    void vault.removeSecret(secretName(c.id)).then(async () => {
      lastCheck.delete(c.id);
      await c.onRemoved();
      c.redraw();
    }, (e: unknown) => status.error(message(e)));
  });
  return [el('div', { className: 'row-head' }, el('span', { textContent: `${c.name} API key saved.` }), el('span', { className: 'row-buttons' }, again, replace, remove)), status.node];
}

/** The provider's API key: unlock, first save (with encryption), saved row, or replace. */
export async function providerKey(c: KeyCtx): Promise<Node[]> {
  const status = await vault.status();
  if (status === 'locked') return unlockBlock('key', `use your ${c.name} API key`, c.vaultChanged);
  const has = canUseSecrets(status) && (await vault.listSecrets()).includes(secretName(c.id));
  return has && !replacing.has(c.id) ? savedRow(c) : keyForm(c, status === 'none');
}

export const hasProviderKey = async (id: CloudId): Promise<boolean> => canUseSecrets(await vault.status()) && (await vault.listSecrets()).includes(secretName(id));

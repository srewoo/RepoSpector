import { el } from './dom.js';
import { Vault, VaultError, type VaultStatus } from './vault.js';

/** One vault for the settings page; keys and tokens are saved in it from the model and host sections. */
export const vault = new Vault(chrome.storage.local, chrome.storage.session);

/** True when secrets can be read and saved right now. */
export const canUseSecrets = (s: VaultStatus): boolean => s === 'unlocked' || s === 'session-only';

function field(id: string, label: string): [HTMLLabelElement, HTMLInputElement] {
  return [el('label', { htmlFor: id, textContent: label }), el('input', { id, name: id, type: 'password', autocomplete: 'off', required: true })];
}

/**
 * Key protection: create the vault (passphrase or memory only), unlock it, lock it, or delete
 * everything. Calls `changed` after any state change so the sections that save keys re-render.
 */
export async function renderVault(root: HTMLElement, say: (t: string) => void, changed: () => void): Promise<void> {
  const rerender = (): void => {
    void renderVault(root, say, changed);
    changed();
  };
  const guard = (what: string, fn: () => Promise<void>) => () =>
    void fn().then(rerender, (e: unknown) => say(e instanceof VaultError ? e.message : `Could not ${what}. Reload this page and try again.`));
  const status = await vault.status();

  if (status === 'none') {
    // Encryption is set up when the first key is saved in step 1, so there is nothing to do here yet.
    root.replaceChildren(el('p', { className: 'muted', textContent: 'No keys saved yet. When you save your API key in step 1, you choose a passphrase that encrypts it on this device, or keep it in memory only.' }));
    return;
  }

  if (status === 'locked') {
    const [l, p] = field('unlock', 'Passphrase');
    const form = el('form', {}, l, p, el('div', { className: 'actions' }, el('button', { type: 'submit', className: 'primary', textContent: 'Unlock keys' })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guard('unlock', async () => (await vault.unlock(p.value), say('Unlocked for this browser session.')))();
    });
    root.replaceChildren(el('p', { textContent: 'Your keys are locked. Enter your passphrase to use them in this browser session.' }), form);
    return;
  }

  const lock = el('button', { type: 'button', textContent: 'Lock keys now' });
  lock.addEventListener('click', guard('lock', async () => (await vault.lock(), say('Locked. Your passphrase is needed to use the keys again.'))));
  const reset = el('button', { type: 'button', textContent: 'Delete all keys and tokens' });
  let armed = false;
  reset.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      reset.textContent = 'Click again to delete everything';
      return;
    }
    guard('delete the keys', async () => (await vault.reset(), say('All keys and tokens deleted.')))();
  });
  const mode = status === 'session-only' ? 'Memory only: keys are forgotten when Chrome closes.' : 'Keys are encrypted and unlocked for this browser session.';
  root.replaceChildren(el('p', { className: 'muted', textContent: mode }), el('div', { className: 'actions' }, ...(status === 'unlocked' ? [lock] : []), reset));
}

import { providerOrigins } from './model-settings.js';
import type { ProviderId } from './providers/types.js';
import { hostOrigins } from './settings.js';
import { loadHosts } from './store.js';
import { tokenHelp } from './token-help.js';
import { Vault, VaultError } from './vault.js';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
] as const;

const vault = new Vault(chrome.storage.local, chrome.storage.session);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function field(id: string, label: string, type = 'text'): [HTMLLabelElement, HTMLInputElement] {
  return [el('label', { htmlFor: id, textContent: label }), el('input', { id, name: id, type, autocomplete: 'off', required: true })];
}

/** Human name for a stored secret, e.g. "Anthropic API key" or "github.com access token". */
function describe(name: string): string {
  if (name.startsWith('host:')) return `${name.slice('host:'.length).replace(/^https:\/\//, '')} access token`;
  return `${PROVIDERS.find((p) => `provider:${p.id}` === name)?.label ?? name} API key`;
}

/** Origins a test of this secret talks to; requested inside the click so Chrome can ask the user. */
function originsFor(name: string): string[] {
  if (name.startsWith('provider:')) return providerOrigins(name.slice('provider:'.length) as ProviderId);
  const origin = name.slice('host:'.length);
  return origin.startsWith('https://github.com') ? hostOrigins({ kind: 'github', origin }) : [`${origin}/*`];
}

function secretRow(name: string, say: (t: string) => void, rerender: () => void): HTMLLIElement {
  const label = describe(name);
  const status = el('p', { className: 'row-status muted', role: 'status' });
  const test = el('button', { type: 'button', textContent: name.startsWith('host:') ? 'Test token' : 'Test key' });
  test.setAttribute('aria-label', `Test ${label}`);
  test.title = name.startsWith('host:') ? 'Reads your own user profile from the host. Changes nothing.' : 'Sends one short prompt to the provider\'s cheapest model; costs a fraction of a cent.';
  test.addEventListener('click', () => {
    test.disabled = true;
    status.className = 'row-status muted';
    status.textContent = 'Checking…';
    // permissions.request must be the first await so it stays inside the click's user gesture.
    chrome.permissions
      .request({ origins: originsFor(name) })
      .catch((e: unknown) => {
        throw new Error(`Chrome could not ask for permission to reach this service (${(e as Error).message}). Click Test again.`);
      })
      .then(async (granted) => {
        if (!granted) throw new Error('Chrome permission for this service was not granted, so the check could not run.');
        const value = await vault.getSecret(name);
        if (!value) throw new Error('This key is no longer saved.');
        const { testSecret } = await import('./key-test.js');
        status.textContent = await testSecret(name, value, { hosts: await loadHosts() });
      })
      .catch((e: unknown) => {
        status.className = 'row-status error';
        status.textContent = e instanceof Error ? e.message : 'The check failed for an unknown reason.';
      })
      .finally(() => (test.disabled = false));
  });
  const remove = el('button', { type: 'button', textContent: 'Remove' });
  remove.setAttribute('aria-label', `Remove ${label}`);
  remove.addEventListener('click', () => {
    void vault.removeSecret(name).then(
      () => (say(`Removed the ${label}.`), rerender()),
      (e: unknown) => say(e instanceof VaultError ? e.message : 'Could not remove it; the vault may be locked.'),
    );
  });
  return el('li', {}, el('div', { className: 'row-head' }, el('span', { className: 'code', textContent: name }), el('span', { className: 'row-buttons' }, test, remove)), status);
}

/** Renders the key section for the vault's current state. Values are never displayed after saving. */
export async function renderKeys(root: HTMLElement, say: (t: string) => void): Promise<void> {
  const rerender = () => void renderKeys(root, say);
  const guard = (what: string, fn: () => Promise<void>) => () =>
    void fn().then(rerender, (e: unknown) => say(e instanceof VaultError ? e.message : `Could not ${what}. Reload this page and try again.`));
  const status = await vault.status();

  if (status === 'none') {
    const [l1, p1] = field('pass1', 'New passphrase (at least 10 characters)', 'password');
    const [l2, p2] = field('pass2', 'Repeat passphrase', 'password');
    const form = el('form', {}, l1, p1, l2, p2, el('div', { className: 'actions' }, el('button', { type: 'submit', className: 'primary', textContent: 'Encrypt my keys with this passphrase' })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (p1.value !== p2.value) return say('The two passphrases do not match.');
      guard('create the vault', async () => (await vault.setup(p1.value), say('Vault created and unlocked for this browser session.')))();
    });
    const sessionOnly = el('button', { type: 'button', textContent: 'Keep keys in memory only, until Chrome closes' });
    sessionOnly.addEventListener('click', guard('switch to memory only', async () => (await vault.useSessionOnly(), say('Keys will be kept in memory only and forgotten when Chrome closes.'))));
    root.replaceChildren(
      el('p', { className: 'muted', textContent: 'Keys and tokens are encrypted on this device with your passphrase, and each is sent only to its own service.' }),
      form,
      el('div', { className: 'actions' }, sessionOnly),
    );
    return;
  }

  if (status === 'locked') {
    const [l, p] = field('unlock', 'Passphrase', 'password');
    const form = el('form', {}, l, p, el('div', { className: 'actions' }, el('button', { type: 'submit', className: 'primary', textContent: 'Unlock keys' })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guard('unlock', async () => (await vault.unlock(p.value), say('Unlocked for this browser session.')))();
    });
    root.replaceChildren(el('p', { textContent: 'Your keys are locked. Enter your passphrase to use them in this browser session.' }), form);
    return;
  }

  const names = await vault.listSecrets();
  const list = el('ul', { className: 'rows' }, ...names.map((n) => secretRow(n, say, rerender)));
  if (names.length === 0) list.append(el('li', { className: 'muted', textContent: 'No keys or tokens yet. Add a model key below, and a token for each git host you review on.' }));

  const hosts = await loadHosts();
  const target = el('select', { id: 'secret-for', name: 'secret-for' });
  for (const p of PROVIDERS) target.append(el('option', { value: `provider:${p.id}`, textContent: `${p.label} API key` }));
  for (const h of hosts) target.append(el('option', { value: `host:${h.origin}`, textContent: `${h.origin.replace(/^https:\/\//, '')} access token` }));
  const [lv, value] = field('secret-value', 'Key or token', 'password');
  // For a git host: which scopes, and a link to that host's token page with them filled in.
  const help = el('p', { id: 'secret-help', className: 'muted' });
  const showHelp = (): void => {
    const host = hosts.find((h) => `host:${h.origin}` === target.value);
    if (!host) return void help.replaceChildren();
    const t = tokenHelp(host);
    help.replaceChildren(`${t.text} `, el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', textContent: `Create one on ${host.origin.replace(/^https:\/\//, '')}` }), '.');
  };
  target.addEventListener('change', showHelp);
  showHelp();
  value.setAttribute('aria-describedby', 'secret-help');
  const add = el('form', {}, el('label', { htmlFor: 'secret-for', textContent: 'Add a key or token for' }), target, help, lv, value, el('div', { className: 'actions' }, el('button', { type: 'submit', className: 'primary', textContent: 'Save key' })));
  add.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = target.value;
    const secret = value.value.trim();
    guard('save the key', async () => (await vault.setSecret(name, secret), say(`Saved the ${describe(name)}. Use Test to check it.`)))();
  });

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
  const mode = status === 'session-only' ? 'Memory only: keys are forgotten when Chrome closes.' : 'Unlocked for this browser session.';
  root.replaceChildren(el('p', { className: 'muted', textContent: mode }), list, add, el('div', { className: 'actions' }, ...(status === 'unlocked' ? [lock] : []), reset));
}

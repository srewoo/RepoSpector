import { button, el } from './dom.js';
import { canUseSecrets, vault } from './keys-ui.js';
import { message, protection, statusLine, unlockBlock } from './secret-ui.js';
import { hostOrigins, normalizeOrigin, type HostSetting } from './settings.js';
import { loadHosts, saveHosts } from './store.js';
import { tokenHelp } from './token-help.js';
import type { VaultStatus } from './vault.js';

const DEFAULT_ORIGIN = { github: 'https://github.com', gitlab: 'https://gitlab.com' } as const;
const kindName = (k: HostSetting['kind']): string => (k === 'github' ? 'GitHub' : 'GitLab');
const shortOrigin = (o: string): string => o.replace(/^https:\/\//, '');
const tokenName = (h: HostSetting): string => `host:${h.origin}`;
/** Last check result per host ("Token works: signed in as …"), kept while the page is open. */
const lastCheck = new Map<string, string>();
/** Hosts whose token form is open (Add token / Replace token). */
const editing = new Set<string>();

interface Env {
  readonly say: (t: string) => void;
  readonly rerender: () => void;
  readonly vaultChanged: () => void;
  readonly status: VaultStatus;
}

/** Reads the user's own profile with this token (read-only). Throws a sentence when the token is wrong. */
async function checkToken(host: HostSetting, token: string): Promise<string> {
  const { testSecret } = await import('./key-test.js');
  return testSecret(tokenName(host), token, { hosts: [host] });
}

function tokenHelpNode(host: HostSetting | null, id: string): HTMLParagraphElement {
  const p = el('p', { className: 'muted', id });
  if (!host) return (p.textContent = 'Needed for private repositories and to post draft comments.'), p;
  const t = tokenHelp(host);
  p.append(`${t.text} `, el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', textContent: `Create one on ${shortOrigin(host.origin)}` }), '.');
  return p;
}

/** Add or replace the token of a connected host: checked with the host before it is saved. */
function tokenForm(h: HostSetting, env: Env, rowStatus: ReturnType<typeof statusLine>): Node[] {
  if (env.status === 'locked') return unlockBlock(`tok-${h.origin}`, 'save a token', env.vaultChanged);
  const id = `token-${shortOrigin(h.origin).replace(/[^a-z0-9]/gi, '-')}`;
  const input = el('input', { id, name: id, type: 'password', autocomplete: 'off', placeholder: 'Paste a personal access token' });
  const protect = protection(env.status, id);
  const save = button('Check and save token', () => {
    const value = input.value.trim();
    if (!value) return rowStatus.error('Paste the token first.');
    const problem = protect.validate();
    if (problem) return rowStatus.error(problem);
    save.disabled = true;
    rowStatus.busy(`Checking the token with ${shortOrigin(h.origin)}…`);
    chrome.permissions
      .request({ origins: hostOrigins(h) })
      .then(async (granted) => {
        if (!granted) throw new Error(`Chrome permission for ${shortOrigin(h.origin)} was not granted, so the token could not be checked.`);
        const result = await checkToken(h, value);
        const created = await protect.ensure();
        await vault.setSecret(tokenName(h), value);
        lastCheck.set(h.origin, result);
        editing.delete(h.origin);
        if (created) env.vaultChanged();
        env.rerender();
      })
      .catch((e: unknown) => ((save.disabled = false), rowStatus.error(`${message(e)} The token was not saved.`)));
  }, true);
  const cancel = button('Cancel', () => (editing.delete(h.origin), env.rerender()));
  return [el('label', { htmlFor: id, textContent: 'Personal access token' }), input, tokenHelpNode(h, `${id}-help`), ...protect.nodes, el('div', { className: 'actions' }, save, cancel)];
}

/** One connected host: its token state and the actions for it. */
function hostRow(h: HostSetting, hasToken: boolean, env: Env): HTMLLIElement {
  const label = `${kindName(h.kind)} · ${shortOrigin(h.origin)}`;
  const status = statusLine(`host-status-${shortOrigin(h.origin).replace(/[^a-z0-9]/gi, '-')}`);
  const last = lastCheck.get(h.origin);
  if (last) status.ok(last);
  else if (hasToken) status.busy('Access token saved. Use Check token to see what it can do.');
  else status.busy('No access token: public repositories only, and no posting of draft comments.');
  const named = (b: HTMLButtonElement, what: string): HTMLButtonElement => (b.setAttribute('aria-label', `${what} for ${label}`), b);
  const buttons: HTMLButtonElement[] = [];
  if (hasToken) {
    const check = button('Check token', () => {
      check.disabled = true;
      status.busy('Checking…');
      chrome.permissions
        .request({ origins: hostOrigins(h) })
        .then(async (granted) => {
          if (!granted) throw new Error(`Chrome permission for ${shortOrigin(h.origin)} was not granted.`);
          const value = await vault.getSecret(tokenName(h));
          if (!value) throw new Error('This token is no longer saved.');
          const result = await checkToken(h, value);
          lastCheck.set(h.origin, result);
          status.ok(result);
        })
        .catch((e: unknown) => (lastCheck.delete(h.origin), status.error(`${message(e)} Replace the token if it expired or was revoked.`)))
        .finally(() => (check.disabled = false));
    });
    check.title = 'Reads your own user profile from the host. Changes nothing.';
    buttons.push(named(check, 'Check token'), named(button('Replace token', () => (editing.add(h.origin), env.rerender())), 'Replace token'));
  } else if (canUseSecrets(env.status) || env.status === 'none') {
    buttons.push(named(button('Add token', () => (editing.add(h.origin), env.rerender())), 'Add token'));
  }
  buttons.push(named(button('Disconnect', () => void disconnectHost(h, env.say).then(env.rerender, (e: unknown) => env.say(message(e)))), 'Disconnect'));
  const form = editing.has(h.origin) ? tokenForm(h, env, status) : [];
  return el('li', {}, el('div', { className: 'row-head' }, el('span', { textContent: label }), el('span', { className: 'row-buttons' }, ...buttons)), status.node, ...form);
}

/** Removes the host, its token, and the Chrome permission no other host still needs. */
async function disconnectHost(h: HostSetting, say: (t: string) => void): Promise<void> {
  const rest = (await loadHosts()).filter((x) => x.origin !== h.origin);
  await saveHosts(rest);
  if (canUseSecrets(await vault.status())) await vault.removeSecret(tokenName(h)).catch(() => undefined);
  lastCheck.delete(h.origin);
  editing.delete(h.origin);
  const stillUsed = new Set(rest.flatMap(hostOrigins));
  const release = hostOrigins(h).filter((o) => !stillUsed.has(o));
  // The host and token are gone either way; failing to release the permission is not worth an error.
  const released = release.length === 0 || (await chrome.permissions.remove({ origins: release }).catch(() => false));
  say(`Disconnected ${shortOrigin(h.origin)} and removed its token${released ? ' and Chrome permission' : ''}.`);
}

/** The "connect a new host" form: service, address, optional token, one Check and connect button. */
function connectForm(env: Env): HTMLFormElement {
  const kind = el('select', { id: 'kind', name: 'kind' }, el('option', { value: 'github', textContent: 'GitHub' }), el('option', { value: 'gitlab', textContent: 'GitLab' }));
  const origin = el('input', { id: 'origin', name: 'origin', required: true, autocomplete: 'off', inputMode: 'url', value: DEFAULT_ORIGIN.github });
  const originHint = el('p', { className: 'muted', id: 'origin-hint' });
  origin.setAttribute('aria-describedby', 'origin-hint');
  const locked = env.status === 'locked';
  const token = el('input', { id: 'token', name: 'token', type: 'password', autocomplete: 'off', placeholder: locked ? '' : 'Paste a personal access token', disabled: locked });
  token.setAttribute('aria-describedby', 'token-help');
  const help = el('div');
  const protect = protection(env.status, 'git');
  const protectBox = el('div', {}, ...protect.nodes);
  const status = statusLine('connect-status');
  const kindValue = (): HostSetting['kind'] => (kind.value === 'gitlab' ? 'gitlab' : 'github');
  const hostOrNull = (): HostSetting | null => {
    try {
      return { kind: kindValue(), origin: normalizeOrigin(origin.value) };
    } catch {
      return null;
    }
  };
  const sync = (): void => {
    originHint.textContent = kindValue() === 'github' ? 'Keep github.com, or enter your GitHub Enterprise address.' : 'Keep gitlab.com, or enter your self-managed GitLab address.';
    const h = tokenHelpNode(hostOrNull(), 'token-help');
    if (locked) h.textContent = 'Your keys are locked: unlock them in step 1 to add a token. You can still connect without one for public repositories.';
    else h.prepend('Optional for public repositories. ');
    help.replaceChildren(h);
    // The passphrase is asked for only when a first secret is about to be saved.
    protectBox.hidden = !token.value.trim();
  };
  kind.addEventListener('change', () => {
    // Swap the default address with the type, but keep an address the user typed.
    if (!origin.value.trim() || Object.values(DEFAULT_ORIGIN).includes(origin.value.trim() as never)) origin.value = DEFAULT_ORIGIN[kindValue()];
    sync();
  });
  origin.addEventListener('input', sync);
  token.addEventListener('input', sync);
  sync();

  const form = el(
    'form',
    { id: 'add' },
    el('label', { htmlFor: 'kind', textContent: 'Service' }),
    kind,
    el('label', { htmlFor: 'origin', textContent: 'Address' }),
    origin,
    originHint,
    el('label', { htmlFor: 'token', textContent: 'Personal access token (optional)' }),
    token,
    help,
    protectBox,
    el('div', { className: 'actions' }, el('button', { type: 'submit', className: 'primary', textContent: 'Check and connect' })),
    status.node,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    let host: HostSetting;
    try {
      host = { kind: kindValue(), origin: normalizeOrigin(origin.value) };
    } catch (e) {
      return status.error(`Check the address: ${message(e)}.`);
    }
    const value = token.value.trim();
    const problem = value ? protect.validate() : null;
    if (problem) return status.error(problem);
    status.busy(value ? `Checking the token with ${shortOrigin(host.origin)}…` : `Connecting ${shortOrigin(host.origin)}…`);
    // permissions.request must run inside the click's user gesture: call it before any other await.
    chrome.permissions
      .request({ origins: hostOrigins(host) })
      .then(async (granted) => {
        if (!granted) throw new Error(`Chrome permission for ${shortOrigin(host.origin)} was not granted, so it was not connected.`);
        // A token is checked before anything is saved: a wrong token leaves no host and no secret behind.
        const result = value ? await checkToken(host, value) : null;
        const created = value ? await protect.ensure() : false;
        if (value) await vault.setSecret(tokenName(host), value);
        await saveHosts([...(await loadHosts()).filter((x) => x.origin !== host.origin), host]);
        if (result) lastCheck.set(host.origin, result);
        env.say(`Connected ${kindName(host.kind)} at ${shortOrigin(host.origin)}${value ? '' : ' without a token: public repositories only'}. Open a pull request there and click the RepoSpector icon to review it.`);
        if (created) env.vaultChanged();
        env.rerender();
      })
      .catch((e: unknown) => status.error(`${message(e)}${value ? ' Nothing was saved.' : ''}`));
  });
  return form;
}

/** Step 2: connect GitHub or GitLab (cloud, Enterprise or self-managed), with a token checked before it is saved. */
export async function renderHosts(root: HTMLElement, say: (t: string) => void, vaultChanged: () => void = () => undefined): Promise<void> {
  const env: Env = { say, vaultChanged, rerender: () => void renderHosts(root, say, vaultChanged), status: await vault.status() };
  const hosts = await loadHosts();
  const saved = new Set(canUseSecrets(env.status) ? await vault.listSecrets() : []);
  const list = el('ul', { className: 'rows', id: 'hosts' }, ...hosts.map((h) => hostRow(h, saved.has(tokenName(h)), env)));
  const intro = el('p', { className: 'muted', textContent: 'RepoSpector reads pull requests only on services you connect here. Chrome asks you to allow each one. Tokens are checked with the service, then encrypted; each is sent only to its own service.' });
  root.replaceChildren(intro, ...(hosts.length ? [list, el('h3', { textContent: 'Connect another' })] : [list]), connectForm(env));
}

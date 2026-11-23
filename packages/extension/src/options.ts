import { renderFeedback } from './feedback-ui.js';
import { renderSavedIndex } from './index-ui.js';
import { renderLocalMode } from './local-ui.js';
import { renderMeaning } from './meaning-ui.js';
import { renderKeys } from './keys-ui.js';
import { renderModel } from './model-ui.js';
import { hostOrigins, normalizeOrigin, type HostSetting } from './settings.js';
import { loadHosts, saveHosts } from './store.js';

const list = document.getElementById('hosts') as HTMLUListElement;
const form = document.getElementById('add') as HTMLFormElement;
const status = document.getElementById('status') as HTMLElement;

function say(text: string): void {
  status.textContent = text;
}

async function render(): Promise<void> {
  const hosts = await loadHosts();
  list.replaceChildren(
    ...hosts.map((h) => {
      const name = `${h.kind === 'github' ? 'GitHub' : 'GitLab'} at ${h.origin.replace(/^https:\/\//, '')}`;
      const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', () => void removeHost(h));
      const head = Object.assign(document.createElement('div'), { className: 'row-head' });
      head.append(Object.assign(document.createElement('span'), { textContent: name }), remove);
      const li = document.createElement('li');
      li.append(head);
      return li;
    }),
  );
  if (hosts.length === 0) list.innerHTML = '<li class="muted">No hosts yet. Add GitHub or GitLab below to review pull requests there.</li>';
}

async function removeHost(h: HostSetting): Promise<void> {
  const rest = (await loadHosts()).filter((x) => x.origin !== h.origin);
  await saveHosts(rest);
  const stillUsed = new Set(rest.flatMap(hostOrigins));
  const release = hostOrigins(h).filter((o) => !stillUsed.has(o));
  if (release.length) await chrome.permissions.remove({ origins: release });
  say(`Removed ${h.origin} and its Chrome permission.`);
  await render();
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const data = new FormData(form);
  const kind = data.get('kind') === 'gitlab' ? 'gitlab' : 'github';
  let origin: string;
  try {
    origin = normalizeOrigin(String(data.get('origin') ?? ''));
  } catch (e) {
    say((e as Error).message);
    return;
  }
  const host: HostSetting = { kind, origin };
  // permissions.request must run inside the click's user gesture: call it before any other await.
  chrome.permissions.request({ origins: hostOrigins(host) }).then(
    async (granted) => {
      if (!granted) return say(`Chrome permission for ${origin} was not granted, so the host was not added.`);
      const hosts = (await loadHosts()).filter((x) => x.origin !== origin);
      await saveHosts([...hosts, host]);
      form.reset();
      say(`Added ${origin}. Add an access token for it under Keys to read private repositories.`);
      await render();
    },
    (e: unknown) => say(`Chrome could not ask for permission: ${(e as Error).message}`),
  );
});

const keys = document.getElementById('keys') as HTMLElement;
void render();
void renderModel(document.getElementById('model') as HTMLElement, say);
void renderKeys(keys, say);
void renderFeedback(document.getElementById('feedback') as HTMLElement, say);
void renderSavedIndex(document.getElementById('saved-index') as HTMLElement, say);
void renderLocalMode(document.getElementById('local-mode') as HTMLElement, say);
void renderMeaning(document.getElementById('meaning') as HTMLElement, say);
// Hosts can change from another settings tab; keep both the host list and the token choices current.
chrome.storage.onChanged.addListener((changes) => {
  if ('hosts' in changes) {
    void render();
    void renderKeys(keys, say);
  }
});

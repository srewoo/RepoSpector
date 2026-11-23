import { mountReview } from './review-ui.js';
import { detectReviewPage } from './settings.js';
import { loadHosts } from './store.js';

const view = document.getElementById('view') as HTMLElement;
let unmount: (() => void) | undefined;
let shownKey = '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function openSettings(label: string, primary: boolean): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label, ...(primary ? { className: 'primary' } : {}) });
  b.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  return b;
}

/** Tab URLs are visible only for hosts the user granted, which is exactly the set we care about. */
async function refresh(): Promise<void> {
  const hosts = await loadHosts();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // A page still loading has only pendingUrl; reading it lets the panel offer the review straight away.
  const url = current?.url || current?.pendingUrl || '';
  const key = `${url}|${hosts.map((h) => h.origin).join(',')}`;
  if (key === shownKey) return; // same page and hosts: keep the live review view
  shownKey = key;
  unmount?.();
  unmount = undefined;
  if (hosts.length === 0) {
    view.replaceChildren(el('p', { textContent: 'Add GitHub or GitLab in settings, then open a pull request or merge request to review it here.' }), openSettings('Open settings', true));
    return;
  }
  const target = url ? detectReviewPage(url, hosts) : null;
  if (!target) {
    view.replaceChildren(el('p', { textContent: 'Open a pull request or merge request on one of your hosts to review it here.' }), el('p', { className: 'muted', textContent: `Your hosts: ${hosts.map((h) => h.origin.replace(/^https:\/\//, '')).join(', ')}.` }), openSettings('Manage hosts', false));
    return;
  }
  const name = target.kind === 'github' ? `${target.owner}/${target.repo} #${target.number}` : `${target.project} !${target.iid}`;
  const area = el('div', { id: 'review' });
  view.replaceChildren(el('p', { className: 'target', textContent: name }), el('p', { className: 'muted', textContent: target.host }), area);
  const host = hosts.find((h) => h.origin === `https://${target.host}`);
  if (host) unmount = mountReview(area, target, host, current?.id);
}

function safeRefresh(): void {
  refresh().catch((e: unknown) => {
    view.replaceChildren(el('p', { className: 'error', textContent: `Could not read your RepoSpector settings: ${(e as Error).message}.` }), openSettings('Open settings', false));
  });
}

chrome.tabs.onActivated.addListener(safeRefresh);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') safeRefresh();
});
chrome.storage.onChanged.addListener((changes) => {
  if ('hosts' in changes) safeRefresh();
});
safeRefresh();

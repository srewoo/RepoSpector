import { button, el } from './dom.js';
import { idbCache, KEEP_GRAPHS } from './graph/cache.js';

/** Settings section for the code index saved on this machine: what is kept, and delete-all behind a second click. */
export async function renderSavedIndex(root: HTMLElement, say: (text: string) => void): Promise<void> {
  const cache = idbCache();
  const { graphs, blobs } = await cache.stats();
  const intro = el('p', { className: 'muted', textContent: `"Show where this code is used" saves its index on this device, so the same commit opens instantly and a new push only re-reads changed files. It keeps function and class names with their positions, never your code, for the last ${KEEP_GRAPHS} commits indexed.` });
  if (graphs === 0) {
    root.replaceChildren(intro, el('p', { textContent: 'Nothing saved yet.' }));
    return;
  }
  let armed = false;
  const remove = button('Delete saved indexes', () => {
    if (!armed) {
      armed = true;
      remove.textContent = 'Click again to delete them';
      return;
    }
    void cache.clear().then(async () => {
      say('Deleted the saved code indexes. They are rebuilt when you next ask where code is used.');
      await renderSavedIndex(root, say);
    });
  });
  root.replaceChildren(intro, el('p', { textContent: `${graphs} commit${graphs === 1 ? '' : 's'} indexed, symbols for ${blobs.toLocaleString('en')} file version${blobs === 1 ? '' : 's'}.` }), el('div', { className: 'actions' }, remove));
}

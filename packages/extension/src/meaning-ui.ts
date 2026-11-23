import { button, el } from './dom.js';
import { deleteModel, downloadModel, loadModel, MODEL, saveModel } from './embed/model.js';

const KEY = 'semanticFeedback';
const MB = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const SIZE = MODEL.files.reduce((n, f) => n + ('bytes' in f ? f.bytes : 0), 0);

export async function semanticFeedbackOn(): Promise<boolean> {
  return (await chrome.storage.local.get(KEY))[KEY] === true && (await loadModel().catch(() => undefined)) !== undefined;
}

/**
 * Settings section for meaning-based feedback matching (opt-in). Turning it on downloads the model
 * once from huggingface.co at a pinned revision and checks every file's SHA-256 before saving it.
 */
export async function renderMeaning(root: HTMLElement, say: (t: string) => void): Promise<void> {
  const rerender = () => void renderMeaning(root, say);
  const on = await semanticFeedbackOn();
  const intro = el('p', { className: 'muted', textContent: `Findings are compared with ones you marked not useful by their shared words. Meaning-based matching also catches the same point worded differently. It uses a small language model (${MODEL.name.split('/')[1]}, ${MB(SIZE)}) that runs on this device; only the model download goes to the internet.` });
  const status = el('p', { role: 'status', className: 'muted' });
  if (on) {
    const off = button('Turn off and delete the model', () => {
      void (async () => {
        await chrome.storage.local.set({ [KEY]: false });
        await deleteModel();
        say('Meaning-based matching is off and the model was deleted.');
        rerender();
      })();
    });
    root.replaceChildren(intro, el('p', { textContent: `On. The model is saved on this device and is used in your next reviews.` }), el('div', { className: 'actions' }, off));
    return;
  }
  const enable = button(`Download the model (${MB(SIZE)}) and turn on`, () => {
    enable.disabled = true;
    status.className = 'muted';
    status.textContent = 'Downloading…';
    void (async () => {
      try {
        const files = await downloadModel((input, init) => fetch(input, init), (bytes) => (status.textContent = `Downloading… ${MB(bytes)} of ${MB(SIZE)}`));
        await saveModel(files);
        await chrome.storage.local.set({ [KEY]: true });
        say('Meaning-based matching is on. The model was checked and saved on this device.');
        rerender();
      } catch (e) {
        status.className = 'error';
        status.textContent = `Could not set it up: ${(e as Error).message}. Nothing was saved.`;
        enable.disabled = false;
      }
    })();
  });
  root.replaceChildren(intro, status, el('div', { className: 'actions' }, enable));
}

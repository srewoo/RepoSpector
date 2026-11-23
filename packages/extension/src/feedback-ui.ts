import { toFeedbackJsonl } from '@repospector/core';
import { button, el } from './dom.js';
import { clearFeedback, feedbackRows } from './pipeline/store.js';

/**
 * Settings section for feedback given in the side panel: how much is stored on this device, an export
 * in the repo's `.RepoSpector/feedback.jsonl` format, and delete-all behind a second click.
 */
export async function renderFeedback(root: HTMLElement, say: (text: string) => void): Promise<void> {
  const rows = await feedbackRows();
  const rejected = rows.filter((r) => r.entry.reaction === 'rejected').length;
  const repos = new Set(rows.map((r) => r.repo)).size;
  const intro = el('p', { className: 'muted', textContent: 'Your reactions to findings stay on this device. Findings like ones you marked not useful are moved down and labelled suspected in later reviews, never hidden.' });
  if (rows.length === 0) {
    root.replaceChildren(intro, el('p', { textContent: 'No feedback yet. React to findings in the side panel to start.' }));
    return;
  }
  const summary = el('p', { textContent: `${rows.length} reaction${rows.length === 1 ? '' : 's'} from ${repos} repositor${repos === 1 ? 'y' : 'ies'}, ${rejected} marked not useful or not relevant.` });

  const exportButton = button('Export as JSONL', () => {
    const url = URL.createObjectURL(new Blob([toFeedbackJsonl(rows.map((r) => r.entry))], { type: 'application/x-ndjson' }));
    const a = el('a', { href: url, download: 'feedback.jsonl' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say('Saved feedback.jsonl. Commit it as .RepoSpector/feedback.jsonl to share it with your team.');
  });

  let armed = false;
  const remove = button('Delete all feedback', () => {
    if (!armed) {
      armed = true;
      remove.textContent = `Click again to delete ${rows.length} reaction${rows.length === 1 ? '' : 's'}`;
      return;
    }
    void clearFeedback().then(async () => {
      say('Deleted all feedback on this device.');
      await renderFeedback(root, say);
    });
  });
  root.replaceChildren(intro, summary, el('div', { className: 'actions' }, exportButton, remove));
}

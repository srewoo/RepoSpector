/** Service worker: opens the side panel from the toolbar button and creates the offscreen document on request. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => console.error('[repospector] side panel:', e));

// First install: open settings, where the get-started checklist walks through setup.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage().catch((e: unknown) => console.error('[repospector] open settings:', e));
});

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Runs code reviews in a worker so they continue when the side panel closes.' })
    .finally(() => (creating = undefined));
  await creating;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || (message as { type?: unknown }).type !== 'offscreen:ensure') return false;
  ensureOffscreen().then(
    () => reply({ ok: true }),
    (e: unknown) => reply({ ok: false, error: (e as Error).message }),
  );
  return true;
});

import { el } from './dom.js';
import { renderFeedback } from './feedback-ui.js';
import { renderHosts } from './hosts-ui.js';
import { renderSavedIndex } from './index-ui.js';
import { canUseSecrets, renderVault, vault } from './keys-ui.js';
import { renderMeaning } from './meaning-ui.js';
import { loadModelSettings, renderModel } from './model-ui.js';
import { loadHosts } from './store.js';

const status = document.getElementById('status') as HTMLElement;
const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function say(text: string): void {
  status.textContent = text;
}

/** What is still missing before the first review, so a new user sees the next step. */
async function renderChecklist(): Promise<void> {
  const [vaultStatus, model, hosts] = await Promise.all([vault.status(), chrome.storage.local.get('model'), loadHosts()]);
  const settings = await loadModelSettings();
  const keyOk = settings.provider === 'ollama' || (canUseSecrets(vaultStatus) && (await vault.listSecrets()).includes(`provider:${settings.provider}`));
  const steps: [boolean, string][] = [
    [keyOk, vaultStatus === 'locked' ? 'Unlock your keys (step 1)' : 'Add your own AI provider API key (step 1)'],
    [model.model !== undefined, 'Choose a model and save it (step 1)'],
    [hosts.length > 0, 'Connect GitHub or GitLab (step 2)'],
  ];
  const items = steps.map(([done, text]) => el('li', { className: done ? 'done' : '' }, el('span', { className: 'mark', textContent: done ? '✓' : '○', ariaHidden: 'true' }), `${text}${done ? ': done' : ''}`));
  const allDone = steps.every(([done]) => done);
  byId('checklist').replaceChildren(...items);
  // Once set up, the checklist turns into a one-line hint on how to start a review.
  const start = byId('checklist').parentElement as HTMLElement;
  start.querySelector('p.next')?.remove();
  if (allDone) start.append(el('p', { className: 'muted next', textContent: 'All set. Open a pull request or merge request and click the RepoSpector icon in the toolbar to review it.' }));
}

const renderGit = (): void => void renderHosts(byId('git'), say, onVaultChange);
const renderModels = (): void => void renderModel(byId('model'), say, onVaultChange);
const renderVaultSection = (): void => void renderVault(byId('vault'), say, () => (renderModels(), renderGit()));
/** Saving the first key or token creates the vault, and unlocking changes it: every section that saves secrets re-renders. */
function onVaultChange(): void {
  renderVaultSection();
  renderModels();
  renderGit();
  void renderChecklist();
}

// The vault gates saving keys and tokens, so its changes re-render every section that saves them.
renderVaultSection();
renderModels();
renderGit();
void renderFeedback(byId('feedback'), say);
void renderSavedIndex(byId('saved-index'), say);
void renderMeaning(byId('meaning'), say);
void renderChecklist();

// Keep the checklist current, and the host list when another settings tab changes it.
chrome.storage.onChanged.addListener((changes) => {
  void renderChecklist();
  if ('hosts' in changes) renderGit();
});

// Settings is a full page: hide the side panel while this tab is active. It reappears on other tabs.
void chrome.tabs
  .getCurrent()
  .then((tab) => (tab?.id === undefined ? undefined : chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false })))
  .catch((e: unknown) => console.warn('[repospector] could not hide the side panel on the settings tab:', e));

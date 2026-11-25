import { fetchClient, hostFor, type ReviewTarget } from '@repospector/core';
import { loadModelSettings } from './model-ui.js';
import { resolveModel } from './model-settings.js';
import { button, el, settingsButton } from './dom.js';
import { estimateReview, type Step } from './pipeline/engine.js';
import { semanticFeedbackOn } from './meaning-ui.js';
import { results } from './results-ui.js';
import type { ActiveRunsReply, StartMessage } from './pipeline/messages.js';
import { latestRunFor, RUN_CHANNEL, targetKey } from './pipeline/store.js';
import { progressView } from './progress-ui.js';
import { vault } from './keys-ui.js';
import { unlockBlock } from './secret-ui.js';
import { GITHUB_CODELOAD } from './graph/archive.js';
import { PRICES_AS_OF } from './providers/presets.js';
import { apiBase, type HostSetting } from './settings.js';
import { Vault } from './vault.js';

const STEP_TEXT: Record<Step, string> = {
  fetch: 'Reading the pull request…',
  context: 'Reading the repository for the code this change calls…',
  review: 'Reviewing the changes',
  verify: 'Checking each finding with a second pass…',
  filter: 'Applying your team\'s feedback…',
};
const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama' } as const;

const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

interface Ready {
  readonly start: Omit<StartMessage, 'runId'>;
  readonly host: HostSetting;
}

/** Everything a run needs, or a sentence saying what is missing. */
async function readiness(target: ReviewTarget, host: HostSetting): Promise<Ready | string> {
  const settings = await loadModelSettings();
  let resolved;
  try {
    resolved = resolveModel(settings);
  } catch (e) {
    return `${(e as Error).message}. Set it in settings.`;
  }
  const vault = new Vault(chrome.storage.local, chrome.storage.session);
  const status = await vault.status();
  if (status === 'locked') return 'Your keys are locked. Unlock them in settings to review.';
  const apiKey = resolved.provider === 'ollama' || status === 'none' ? undefined : await vault.getSecret(`provider:${resolved.provider}`);
  if (resolved.provider !== 'ollama' && !apiKey) return `Add your ${PROVIDER_NAMES[resolved.provider]} API key in settings to review with ${resolved.model}.`;
  const hostToken = status === 'none' ? undefined : await vault.getSecret(`host:${host.origin}`);
  return {
    host,
    start: { type: 'review:start', target, apiBase: apiBase(host), ...(hostToken ? { hostToken } : {}), provider: resolved.provider, model: resolved.model, ...(apiKey ? { apiKey } : {}), ...(settings.ollamaUrl ? { ollamaUrl: settings.ollamaUrl } : {}), prices: resolved.prices, repoContext: true, ...((await semanticFeedbackOn()) ? { semanticFeedback: true } : {}) },
  };
}

async function activeRuns(): Promise<readonly string[]> {
  try {
    return ((await chrome.runtime.sendMessage<ActiveRunsReply>({ type: 'review:active' })) ?? { active: [] }).active;
  } catch {
    return []; // no offscreen document: nothing is running
  }
}

async function start(ready: Ready, runId: string, extra: Pick<StartMessage, 'fullReview' | 'fixFindingId'> = {}): Promise<void> {
  const ok = await chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({ type: 'offscreen:ensure' });
  if (!ok?.ok) throw new Error(`Could not start the review runner: ${ok?.error ?? 'no reply'}`);
  await chrome.runtime.sendMessage({ ...ready.start, runId, ...extra } satisfies StartMessage);
}

/**
 * The review area of the side panel for one pull request. Re-renders on progress broadcast by the
 * worker. Returns a function that stops listening (call it when the tab changes).
 */
export function mountReview(root: HTMLElement, target: ReviewTarget, host: HostSetting, tabId?: number): () => void {
  const channel = new BroadcastChannel(RUN_CHANNEL);
  let disposed = false;
  let estimate: { size: number } | undefined;
  let stopProgress: (() => void) | undefined;
  const show = (...nodes: Node[]) => {
    stopProgress?.();
    stopProgress = undefined;
    if (!disposed) root.replaceChildren(...nodes);
  };
  const keepRunningNote = (): HTMLElement => el('p', { className: 'muted', textContent: 'You can close this panel; the review keeps running.' });
  const showProgress = (step: Step, model: string, startedAt: number): void => {
    const p = progressView(step, model, startedAt);
    show(...p.nodes, keepRunningNote());
    stopProgress = p.stop;
  };

  /**
   * Every button that starts or resumes a review: on github.com the repository download comes from
   * codeload.github.com, and Chrome asks for that permission only inside a click, so ask first.
   * Declining is fine: the review then reads the diff only and says why.
   */
  const launch = (ready: Ready, runId: string, fullReview = false) => {
    const origins = target.kind === 'github' && target.host === 'github.com' ? [GITHUB_CODELOAD] : [];
    void (origins.length ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(true)).then(() => begin(ready, runId, fullReview));
  };
  const begin = (ready: Ready, runId: string, fullReview: boolean) => {
    showProgress('fetch', ready.start.model, Date.now());
    start(ready, runId, fullReview ? { fullReview } : {}).catch((e: unknown) => show(el('p', { className: 'error', textContent: (e as Error).message }), button('Try again', () => void render())));
  };

  async function render(): Promise<void> {
    // The unlocked key lives in session memory, which Chrome clears on restart (and on extension
    // reload): unlock right here and carry on, instead of a trip to settings.
    if ((await vault.status()) === 'locked') {
      show(...unlockBlock('panel', `review this ${target.kind === 'github' ? 'pull request' : 'merge request'}`, () => void render()));
      (root.querySelector('input[type="password"]') as HTMLInputElement | null)?.focus();
      return;
    }
    const ready = await readiness(target, host);
    if (typeof ready === 'string') return show(el('p', { textContent: ready }), settingsButton());
    const run = await latestRunFor(target);
    const fresh = () => launch(ready, crypto.randomUUID());

    if (run?.status === 'running') {
      if ((await activeRuns()).includes(run.id)) {
        return showProgress(run.step, run.model, run.startedAt);
      }
      return show(el('p', { textContent: `This review stopped at "${STEP_TEXT[run.step].replace('…', '')}", probably because Chrome closed it.` }), el('p', { className: 'muted', textContent: 'Resume continues from that step; earlier steps are not paid for again.' }), el('div', { className: 'actions' }, button('Resume review', () => launch(ready, run.id), true), button('Start over', fresh)));
    }
    if (run?.status === 'failed') {
      const next = run.error?.kind === 'auth' ? settingsButton() : button('Try again', () => launch(ready, run.id), true);
      return show(el('p', { className: 'error', textContent: run.error?.message ?? 'The review failed.' }), el('div', { className: 'actions' }, next, ...(run.error?.kind === 'auth' ? [] : [button('Start over', fresh)])));
    }
    if (run?.status === 'done') {
      const askFix = (findingId: string): Promise<void> => start(ready, run.id, { fixFindingId: findingId });
      return show(...(await results({ run, target, apiBase: ready.start.apiBase, hostOrigin: host.origin, hostToken: ready.start.hostToken, tabId, again: fresh, full: () => launch(ready, crypto.randomUUID(), true), askFix })));
    }

    show(el('p', { className: 'muted', textContent: 'Measuring the change to estimate the cost…' }));
    try {
      estimate ??= { size: (await hostFor(target, fetchClient({ kind: target.kind, base: ready.start.apiBase, token: ready.start.hostToken })).diff()).length };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const site = host.origin.replace(/^https:\/\//, '');
      const noun = target.kind === 'github' ? 'pull request' : 'merge request';
      // With a saved token, 401 means that token was rejected (expired or revoked), not that one is missing.
      const why =
        status === 401 && ready.start.hostToken ? `${site} rejected your saved access token (401); it may have expired or been revoked. Replace it in settings (GitHub and GitLab, Replace token).`
        : status === 401 || status === 403 || status === 404 ? ready.start.hostToken ? `Could not read this ${noun} (${status}). Your access token for ${site} may not have access to this repository; check its scopes in settings.` : `Could not read this ${noun} (${status}). If the repository is private, add an access token for ${site} in settings.`
        : `Could not read this ${noun}: ${(e as Error).message}`;
      return show(el('p', { className: 'error', textContent: why }), el('div', { className: 'actions' }, button('Try again', () => void render()), settingsButton()));
    }
    const cost = estimateReview(estimate.size, ready.start.prices, true);
    const price = ready.start.provider === 'ollama' ? 'Runs on your machine with Ollama; no model cost.' : cost ? `Estimated cost ${money(cost.lowUsd)} to ${money(cost.highUsd)} (prices as of ${PRICES_AS_OF}).` : 'Cost unknown for a custom model id.';
    show(
      el('p', { textContent: `Reviews ${Math.ceil(estimate.size / 1000)} KB of changes with ${ready.start.model}. It reads the repository to find the code this change calls, reviews the change with and without that code, then checks each finding.` }),
      el('p', { className: 'muted', textContent: price }),
      el('div', { className: 'actions' }, button(target.kind === 'github' ? 'Review this pull request' : 'Review this merge request', fresh, true)),
    );
  }

  channel.onmessage = () => void render();
  // Unlocked or locked from settings (or another panel): follow along.
  const onStorage = (_changes: Record<string, unknown>, area: string): void => {
    if (area === 'session') void render();
  };
  chrome.storage.onChanged.addListener(onStorage);
  void render().catch((e: unknown) => show(el('p', { className: 'error', textContent: `Could not load the review: ${(e as Error).message}` })));
  return () => {
    disposed = true;
    stopProgress?.();
    chrome.storage.onChanged.removeListener(onStorage);
    channel.close();
  };
}

export { targetKey };

import { fetchClient, hostFor, type ReviewTarget } from '@repospector/core';
import { loadModelSettings } from './model-ui.js';
import { resolveModel } from './model-settings.js';
import { button, el, settingsButton } from './dom.js';
import { estimateReview, type Step } from './pipeline/engine.js';
import { semanticFeedbackOn } from './meaning-ui.js';
import { results } from './results-ui.js';
import type { ActiveRunsReply, StartMessage } from './pipeline/messages.js';
import { latestRunFor, RUN_CHANNEL, targetKey } from './pipeline/store.js';
import { PRICES_AS_OF } from './providers/presets.js';
import { apiBase, type HostSetting } from './settings.js';
import { Vault } from './vault.js';

const STEP_TEXT: Record<Step, string> = {
  fetch: 'Reading the pull request…',
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
    start: { type: 'review:start', target, apiBase: apiBase(host), ...(hostToken ? { hostToken } : {}), provider: resolved.provider, model: resolved.model, ...(apiKey ? { apiKey } : {}), ...(settings.ollamaUrl ? { ollamaUrl: settings.ollamaUrl } : {}), prices: resolved.prices, ...((await semanticFeedbackOn()) ? { semanticFeedback: true } : {}) },
  };
}

async function activeRuns(): Promise<readonly string[]> {
  try {
    return ((await chrome.runtime.sendMessage<ActiveRunsReply>({ type: 'review:active' })) ?? { active: [] }).active;
  } catch {
    return []; // no offscreen document: nothing is running
  }
}

async function start(ready: Ready, runId: string): Promise<void> {
  const ok = await chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({ type: 'offscreen:ensure' });
  if (!ok?.ok) throw new Error(`Could not start the review runner: ${ok?.error ?? 'no reply'}`);
  await chrome.runtime.sendMessage({ ...ready.start, runId } satisfies StartMessage);
}

/**
 * The review area of the side panel for one pull request. Re-renders on progress broadcast by the
 * worker. Returns a function that stops listening (call it when the tab changes).
 */
export function mountReview(root: HTMLElement, target: ReviewTarget, host: HostSetting, tabId?: number): () => void {
  const channel = new BroadcastChannel(RUN_CHANNEL);
  let disposed = false;
  let estimate: { size: number } | undefined;
  const show = (...nodes: Node[]) => {
    if (!disposed) root.replaceChildren(...nodes);
  };

  const launch = (ready: Ready, runId: string) => {
    show(el('p', { textContent: STEP_TEXT.fetch }));
    start(ready, runId).catch((e: unknown) => show(el('p', { className: 'error', textContent: (e as Error).message }), button('Try again', () => void render())));
  };

  async function render(): Promise<void> {
    const ready = await readiness(target, host);
    if (typeof ready === 'string') return show(el('p', { textContent: ready }), settingsButton());
    const run = await latestRunFor(target);
    const fresh = () => launch(ready, crypto.randomUUID());

    if (run?.status === 'running') {
      if ((await activeRuns()).includes(run.id)) {
        const text = run.step === 'review' ? `${STEP_TEXT.review} with ${run.model}…` : STEP_TEXT[run.step];
        return show(el('p', { textContent: text }), el('p', { className: 'muted', textContent: 'You can close this panel; the review keeps running.' }));
      }
      return show(el('p', { textContent: `This review stopped at "${STEP_TEXT[run.step].replace('…', '')}", probably because Chrome closed it.` }), el('p', { className: 'muted', textContent: 'Resume continues from that step; earlier steps are not paid for again.' }), el('div', { className: 'actions' }, button('Resume review', () => launch(ready, run.id), true), button('Start over', fresh)));
    }
    if (run?.status === 'failed') {
      const next = run.error?.kind === 'auth' ? settingsButton() : button('Try again', () => launch(ready, run.id), true);
      return show(el('p', { className: 'error', textContent: run.error?.message ?? 'The review failed.' }), el('div', { className: 'actions' }, next, ...(run.error?.kind === 'auth' ? [] : [button('Start over', fresh)])));
    }
    if (run?.status === 'done') return show(...(await results({ run, target, apiBase: ready.start.apiBase, hostOrigin: host.origin, hostToken: ready.start.hostToken, tabId, again: fresh })));

    show(el('p', { className: 'muted', textContent: 'Measuring the change to estimate the cost…' }));
    try {
      estimate ??= { size: (await hostFor(target, fetchClient({ kind: target.kind, base: ready.start.apiBase, token: ready.start.hostToken })).diff()).length };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const why = status === 401 || status === 403 || status === 404 ? `Could not read this pull request (${status}). If the repository is private, add an access token for ${host.origin} in settings.` : `Could not read this pull request: ${(e as Error).message}`;
      return show(el('p', { className: 'error', textContent: why }), el('div', { className: 'actions' }, button('Try again', () => void render()), settingsButton()));
    }
    const cost = estimateReview(estimate.size, ready.start.prices);
    const price = ready.start.provider === 'ollama' ? 'Runs on your machine with Ollama; no model cost.' : cost ? `Estimated cost ${money(cost.lowUsd)} to ${money(cost.highUsd)} (prices as of ${PRICES_AS_OF}).` : 'Cost unknown for a custom model id.';
    show(
      el('p', { textContent: `Reviews ${Math.ceil(estimate.size / 1000)} KB of changes with ${ready.start.model}, then checks each finding with a second pass.` }),
      el('p', { className: 'muted', textContent: price }),
      el('div', { className: 'actions' }, button(target.kind === 'github' ? 'Review this pull request' : 'Review this merge request', fresh, true)),
    );
  }

  channel.onmessage = () => void render();
  void render().catch((e: unknown) => show(el('p', { className: 'error', textContent: `Could not load the review: ${(e as Error).message}` })));
  return () => {
    disposed = true;
    channel.close();
  };
}

export { targetKey };

import { fetchClient, hostFor } from '@repospector/core';
import { createProvider } from '../providers/index.js';
import { runReview, newRun } from './engine.js';
import { StartMessageSchema } from './messages.js';
import { getRun, loadFeedback, pruneRuns, putRun, RUN_CHANNEL } from './store.js';

/** Dedicated worker hosted by the offscreen document: runs reviews off the UI and the service worker. */
const channel = new BroadcastChannel(RUN_CHANNEL);
// The extension compiles with the DOM lib; this is the slice of the worker scope used here.
const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; postMessage(message: unknown): void };

scope.onmessage = (ev: MessageEvent) => {
  const parsed = StartMessageSchema.safeParse(ev.data);
  if (!parsed.success) return;
  const m = parsed.data;
  void (async () => {
    scope.postMessage({ type: 'started', runId: m.runId });
    try {
      const provider = m.provider === 'ollama' ? createProvider({ id: 'ollama', model: m.model, ...(m.ollamaUrl ? { baseUrl: m.ollamaUrl } : {}) }) : createProvider({ id: m.provider, apiKey: m.apiKey ?? '', model: m.model });
      const host = hostFor(m.target, fetchClient({ kind: m.target.kind, base: m.apiBase, token: m.hostToken }));
      const existing = await getRun(m.runId);
      const start = existing && existing.status !== 'done' ? existing : newRun(m.runId, m.target, provider, Date.now());
      await runReview(start, {
        host,
        provider,
        prices: m.prices,
        feedback: await loadFeedback(),
        // Loaded on demand (the ONNX runtime is large), only if the user turned it on.
        ...(m.semanticFeedback ? { meaning: async (texts: readonly string[]) => (await (await import('../embed/load.js')).loadMeaning())(texts) } : {}),
        now: () => Date.now(),
        save: async (run) => {
          await putRun(run);
          channel.postMessage({ runId: run.id });
        },
      });
      await pruneRuns();
    } finally {
      scope.postMessage({ type: 'finished', runId: m.runId });
    }
  })();
};

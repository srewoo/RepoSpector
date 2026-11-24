import { fetchClient, hostFor } from '@repospector/core';
import { createProvider } from '../providers/index.js';
import type { GraphJob, LocateReply } from '../graph/messages.js';
import { runReview, newRun } from './engine.js';
import { gatherRepoContext } from './repo-context.js';
import { StartMessageSchema } from './messages.js';
import { getRun, loadFeedback, pruneRuns, putRun, RUN_CHANNEL } from './store.js';

/** Dedicated worker hosted by the offscreen document: runs reviews off the UI and the service worker. */
const channel = new BroadcastChannel(RUN_CHANNEL);
// The extension compiles with the DOM lib; this is the slice of the worker scope used here.
const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; postMessage(message: unknown): void };

/** Indexing a large repository can take minutes; past this the review goes on with the diff only. */
const LOCATE_TIMEOUT_MS = 5 * 60_000;
const pending = new Map<string, (r: LocateReply) => void>();

/** Asks the offscreen document (which owns the graph worker) to locate definitions at the PR head. */
function locate(job: Omit<GraphJob, 'maxDownloadBytes'>): Promise<Extract<LocateReply, { type: 'located' }>> {
  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('reading the repository took longer than 5 minutes'));
    }, LOCATE_TIMEOUT_MS);
    pending.set(reqId, (r) => {
      clearTimeout(timer);
      pending.delete(reqId);
      if (r.type === 'located') resolve(r);
      else reject(new Error(r.message));
    });
    scope.postMessage({ type: 'locate', reqId, job });
  });
}

scope.onmessage = (ev: MessageEvent) => {
  const reply = ev.data as Partial<LocateReply> | undefined;
  if ((reply?.type === 'located' || reply?.type === 'locate-failed') && typeof reply.reqId === 'string') return void pending.get(reply.reqId)?.(reply as LocateReply);
  const parsed = StartMessageSchema.safeParse(ev.data);
  if (!parsed.success) return;
  const m = parsed.data;
  void (async () => {
    scope.postMessage({ type: 'started', runId: m.runId });
    try {
      const provider = m.provider === 'ollama' ? createProvider({ id: 'ollama', model: m.model, ...(m.ollamaUrl ? { baseUrl: m.ollamaUrl } : {}) }) : createProvider({ id: m.provider, apiKey: m.apiKey ?? '', model: m.model });
      const api = fetchClient({ kind: m.target.kind, base: m.apiBase, token: m.hostToken });
      const host = hostFor(m.target, api);
      const existing = await getRun(m.runId);
      const start = existing && existing.status !== 'done' ? existing : newRun(m.runId, m.target, provider, Date.now());
      await runReview(start, {
        host,
        provider,
        prices: m.prices,
        feedback: await loadFeedback(),
        // Loaded on demand (the ONNX runtime is large), only if the user turned it on.
        ...(m.semanticFeedback ? { meaning: async (texts: readonly string[]) => (await (await import('../embed/load.js')).loadMeaning())(texts) } : {}),
        ...(m.repoContext === false ? {} : { repoContext: (input: { diff: string; headSha: string }) => gatherRepoContext(input, { target: m.target, apiBase: m.apiBase, hostToken: m.hostToken, api, fileAt: (p, sha) => host.fileAt(p, sha), locate }) }),
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

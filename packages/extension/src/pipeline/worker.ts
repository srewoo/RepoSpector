import { changedSince, ciChecks, fetchClient, hostFor, linkedIssues, prDetails, rulesAt, type ApiClient, type ReviewTarget } from '@repospector/core';
import { createProvider } from '../providers/index.js';
import type { GraphJob, LocateReply } from '../graph/messages.js';
import { runReview, newRun, type PrExtras } from './engine.js';
import { suggestFix } from './fix.js';
import { gatherRepoContext } from './repo-context.js';
import { StartMessageSchema } from './messages.js';
import { getRun, latestDoneRunFor, loadFeedback, pruneRuns, putRun, RUN_CHANNEL } from './store.js';

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

/** Rules at the PR base, linked issues and CI results, read with the same API client as the review. */
async function prExtras(target: ReviewTarget, api: ApiClient, fileAt: (p: string, sha: string) => Promise<string>, headSha: string): Promise<PrExtras> {
  const d = await prDetails(target, api);
  const [rules, linked, ci] = await Promise.all([
    d.baseSha ? rulesAt(fileAt, d.baseSha) : Promise.resolve({ text: '', files: [] }),
    linkedIssues(target, api, d),
    ciChecks(target, api, headSha).then(
      (checks) => ({ checks, checksError: undefined }),
      (e: unknown) => ({ checks: null, checksError: (e as { status?: number }).status === 403 || (e as { status?: number }).status === 401 ? 'the access token cannot read CI results' : (e as Error).message.slice(0, 120) }),
    ),
  ]);
  return { rules, issues: linked.issues, ticketKeys: linked.ticketKeys, checks: ci.checks, checksError: ci.checksError };
}

const save = async (run: Parameters<typeof putRun>[0]): Promise<void> => {
  await putRun(run);
  channel.postMessage({ runId: run.id });
};

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
      if (m.fixFindingId) {
        const run = await getRun(m.runId);
        if (run?.status === 'done') await suggestFix(run, m.fixFindingId, { provider, prices: m.prices, fileAt: (p, sha) => host.fileAt(p, sha), save });
        return;
      }
      const existing = await getRun(m.runId);
      const previous = m.fullReview ? undefined : await latestDoneRunFor(m.target, m.runId);
      const start = existing && existing.status !== 'done' ? existing : newRun(m.runId, m.target, provider, Date.now());
      await runReview(start, {
        host,
        provider,
        prices: m.prices,
        feedback: await loadFeedback(),
        // Loaded on demand (the ONNX runtime is large), only if the user turned it on.
        ...(m.semanticFeedback ? { meaning: async (texts: readonly string[]) => (await (await import('../embed/load.js')).loadMeaning())(texts) } : {}),
        ...(m.repoContext === false ? {} : { repoContext: (input: { diff: string; headSha: string }) => gatherRepoContext(input, { target: m.target, apiBase: m.apiBase, hostToken: m.hostToken, api, fileAt: (p, sha) => host.fileAt(p, sha), locate }) }),
        extras: (headSha: string) => prExtras(m.target, api, (p, sha) => host.fileAt(p, sha), headSha),
        ...(previous?.headSha ? { previous: { headSha: previous.headSha, findings: (previous.findings ?? []).filter((f) => f.source !== 'ci') }, changedSince: (from: string, to: string) => changedSince(m.target, api, from, to) } : {}),
        now: () => Date.now(),
        save,
      });
      await pruneRuns();
    } finally {
      scope.postMessage({ type: 'finished', runId: m.runId });
    }
  })();
};

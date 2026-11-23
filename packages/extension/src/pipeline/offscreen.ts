import { GraphStartSchema, MAX_DOWNLOAD_BYTES, type GraphEvent, type GraphJob, type GraphStart } from '../graph/messages.js';
import type { FindingContext } from '@repospector/core';
import type { ContextState, RunRecord } from './engine.js';
import { StartMessageSchema, type ActiveRunsReply } from './messages.js';
import { getRun, putRun, RUN_CHANNEL } from './store.js';

/**
 * Offscreen document (reason: WORKERS). Hosts the review worker so a review keeps running when the
 * side panel closes or Chrome stops the service worker. Accepts messages only from this extension.
 */
const worker = new Worker('worker.js', { type: 'module' });
const active = new Set<string>();

worker.onmessage = (ev: MessageEvent<{ type: string; runId: string }>) => {
  if (ev.data.type === 'started') active.add(ev.data.runId);
  if (ev.data.type === 'finished') active.delete(ev.data.runId);
};

const channel = new BroadcastChannel(RUN_CHANNEL);
const graphs = new Set<string>();

async function setContext(runId: string, context: ContextState): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  await putRun({ ...run, context } satisfies RunRecord);
  channel.postMessage({ runId });
}

/**
 * Builds reader context in a classic worker (tree-sitter's runtime is a classic script). A request
 * with no archive URL may only use the saved index; if there is none, the run is left as it was.
 */
function buildGraph(m: GraphStart): void {
  graphs.add(m.runId);
  const startedAt = Date.now();
  const w = new Worker('graph-worker.js');
  const finish = (state: ContextState | undefined) => {
    w.terminate();
    graphs.delete(m.runId);
    if (state) void setContext(m.runId, state);
    else channel.postMessage({ runId: m.runId });
  };
  w.onmessage = (ev: MessageEvent<GraphEvent>) => {
    const e = ev.data;
    if (e.type === 'progress') void setContext(m.runId, { status: 'running', files: e.files, downloadedMB: e.downloadedMB, startedAt });
    else if (e.type === 'done') finish({ status: 'done', source: e.source, files: e.files, skipped: e.skipped, reused: e.reused, ms: e.ms, perFinding: e.context as Record<string, FindingContext> });
    else finish(e.noSavedIndex ? undefined : { status: 'failed', message: e.message });
  };
  w.onerror = (e) => finish({ status: 'failed', message: `the indexer stopped: ${e.message}` });
  if (m.archiveUrl) void setContext(m.runId, { status: 'running', files: 0, downloadedMB: 0, startedAt });
  const { type: _type, runId: _runId, ...job } = m;
  w.postMessage({ ...job, maxDownloadBytes: MAX_DOWNLOAD_BYTES } satisfies GraphJob);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const m = message as { type?: unknown };
  if (m.type === 'review:active') {
    reply({ active: [...active] } satisfies ActiveRunsReply);
    return false;
  }
  if (m.type === 'graph:active') {
    reply({ active: [...graphs] } satisfies ActiveRunsReply);
    return false;
  }
  if (m.type === 'graph:build') {
    const parsed = GraphStartSchema.safeParse(message);
    if (parsed.success && !graphs.has(parsed.data.runId)) buildGraph(parsed.data);
    return false;
  }
  if (m.type === 'review:start') {
    const parsed = StartMessageSchema.safeParse(message);
    if (!parsed.success || active.has(parsed.data.runId)) return false;
    active.add(parsed.data.runId);
    worker.postMessage(parsed.data);
  }
  return false;
});

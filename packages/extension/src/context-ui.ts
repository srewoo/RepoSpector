import { fetchClient, type FindingContext, type ReviewTarget } from '@repospector/core';
import { button, el } from './dom.js';
import { archivePlan } from './graph/archive.js';
import { idbCache } from './graph/cache.js';
import { localContext, localModeOn } from './local-mode.js';
import { getRun, putRun, RUN_CHANNEL } from './pipeline/store.js';
import { repoOf } from './review/feedback.js';
import type { RunRecord } from './pipeline/engine.js';
import type { ActiveRunsReply } from './pipeline/messages.js';

export interface ContextDeps {
  readonly run: RunRecord;
  readonly target: ReviewTarget;
  readonly apiBase: string;
  readonly hostToken?: string | undefined;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Link to a line in the repository at the reviewed commit. */
function blobUrl(t: ReviewTarget, sha: string, file: string, line: number): string {
  const path = file.split('/').map(encodeURIComponent).join('/');
  return t.kind === 'github' ? `https://${t.host}/${t.owner}/${t.repo}/blob/${sha}/${path}#L${line}` : `https://${t.host}/${t.project}/-/blob/${sha}/${path}#L${line}`;
}

function placeList(t: ReviewTarget, sha: string, items: readonly { file: string; line: number; label?: string | undefined }[]): HTMLUListElement {
  return el('ul', { className: 'places' }, ...items.map((p) => el('li', {}, el('a', { href: blobUrl(t, sha, p.file, p.line), target: '_blank', rel: 'noopener noreferrer', className: 'code', textContent: `${p.file}:${p.line}` }), ...(p.label ? [` ${p.label}`] : []))));
}

/** "Where this code is used" for one finding, collapsed by default. */
export function findingContext(c: FindingContext | undefined, t: ReviewTarget, sha: string): HTMLElement | null {
  if (!c) return null;
  const counts = [plural(c.callerCount, 'caller'), ...(c.subtypes.length ? [plural(c.subtypes.length, 'subclass', 'subclasses')] : []), ...(c.sameName.length ? [`${c.sameName.length} with the same name`] : [])];
  const summary = el('summary', {}, 'In ', el('span', { className: 'code', textContent: c.symbol.name }), ` · ${counts.join(' · ')}`);
  const body: Node[] = [];
  if (c.callers.length) body.push(el('p', { className: 'muted', textContent: c.callerCount > c.callers.length ? `Called from (first ${c.callers.length} of ${c.callerCount}):` : 'Called from:' }), placeList(t, sha, c.callers.map((x) => ({ ...x, label: x.caller ? `in ${x.caller}` : undefined }))));
  if (c.subtypes.length) body.push(el('p', { className: 'muted', textContent: 'Subclasses:' }), placeList(t, sha, c.subtypes.map((x) => ({ ...x, label: x.name }))));
  if (c.sameName.length) body.push(el('p', { className: 'muted', textContent: 'Other definitions with this name (overrides or unrelated):' }), placeList(t, sha, c.sameName));
  if (body.length === 0) body.push(el('p', { className: 'muted', textContent: 'No callers found in the indexed files.' }));
  return el('details', { className: 'context' }, summary, ...body);
}

async function graphActive(runId: string): Promise<boolean> {
  try {
    return ((await chrome.runtime.sendMessage<ActiveRunsReply>({ type: 'graph:active' })) ?? { active: [] }).active.includes(runId);
  } catch {
    return false;
  }
}

const buildMessage = (d: ContextDeps) => ({ type: 'graph:build', runId: d.run.id, repo: repoOf(d.target), sha: d.run.headSha ?? '', findings: (d.run.findings ?? []).map(({ id, file, line }) => ({ id, file, line })) });

/** Local mode: per run, the outcome of asking the user's clone ('' while asking), so it is asked once. */
const localTried = new Map<string, string>();

/** Asks the local program; on success the context goes on the run, otherwise the reason is shown once. */
function askLocal(d: ContextDeps): void {
  localTried.set(d.run.id, '');
  const started = Date.now();
  void localContext(repoOf(d.target), d.run.headSha ?? '', (d.run.findings ?? []).map(({ id, file, line }) => ({ id, file, line }))).then(async (r) => {
    const run = await getRun(d.run.id);
    if (r.ok && run) await putRun({ ...run, context: { status: 'done', source: 'local', files: r.files, skipped: 0, reused: r.files, ms: Date.now() - started, perFinding: r.context } });
    else localTried.set(d.run.id, r.ok ? 'The review is gone.' : r.message);
    const channel = new BroadcastChannel(RUN_CHANNEL);
    channel.postMessage({ runId: d.run.id });
    channel.close();
  });
}

/** Uses the index saved on this machine for this commit, if any: no download, no permission needed. */
async function useSaved(d: ContextDeps): Promise<boolean> {
  if (!d.run.headSha || !(await idbCache().getGraph(`${repoOf(d.target)}@${d.run.headSha}`).catch(() => undefined))) return false;
  const ok = await chrome.runtime.sendMessage<{ ok: boolean }>({ type: 'offscreen:ensure' }).catch(() => undefined);
  if (!ok?.ok) return false;
  await chrome.runtime.sendMessage(buildMessage(d));
  return true;
}

/** Starts the index; the permission request must be the first await, inside the click. */
function start(d: ContextDeps, status: HTMLElement, trigger: HTMLButtonElement): void {
  trigger.disabled = true;
  status.className = 'muted';
  status.textContent = 'Starting…';
  const origins = d.target.host === 'github.com' ? ['https://codeload.github.com/*'] : [];
  (origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true))
    .then(async (granted) => {
      if (!granted) throw new Error('Chrome permission for codeload.github.com (where GitHub serves repository downloads) was not granted.');
      if (!d.run.headSha) throw new Error('This review has no commit to index. Review again.');
      const plan = await archivePlan(d.target, d.apiBase, d.run.headSha, fetchClient({ kind: d.target.kind, base: d.apiBase, token: d.hostToken }));
      if (plan.private && !d.hostToken) throw new Error('This repository is private: add an access token for it in settings to index it.');
      const ok = await chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({ type: 'offscreen:ensure' });
      if (!ok?.ok) throw new Error(`Could not start the indexer: ${ok?.error ?? 'no reply'}`);
      const github = d.target.kind === 'github' ? { githubRepoApi: `${d.apiBase}/repos/${d.target.owner}/${d.target.repo}`, ...(d.hostToken ? { apiToken: d.hostToken } : {}) } : {};
      await chrome.runtime.sendMessage({ ...buildMessage(d), archiveUrl: plan.url, ...(plan.private ? { token: d.hostToken } : {}), ...github });
    })
    .catch((e: unknown) => {
      status.className = 'error';
      status.textContent = (e as Error).message;
      trigger.disabled = false;
    });
}

/** The panel section that offers, tracks and summarises the index for this run. */
export async function contextSection(d: ContextDeps): Promise<HTMLElement> {
  const status = el('p', { className: 'muted', role: 'status' });
  const offer = (label: string): HTMLButtonElement => {
    const b = button(label, () => start(d, status, b));
    return b;
  };
  const section = el('div', { className: 'context-section' });
  const c = d.run.context;
  if (c?.status === 'done') {
    const how =
      c.source === 'local'
        ? `From your local clone (${plural(c.files, 'source file')}, ${(c.ms / 1000).toFixed(1)} s).`
        : c.source === 'saved'
        ? `Used the index saved on this device for this commit (${plural(c.files, 'source file')}).`
        : c.source === 'changed-files'
          ? `Updated the saved index: fetched and parsed ${plural(c.files - c.reused, 'changed file')}, reused ${c.reused}.`
          : `Downloaded and indexed ${plural(c.files, 'source file')} in ${(c.ms / 1000).toFixed(1)} s${c.reused ? `, reusing ${c.reused} saved` : ''}. Saved on this device for next time.`;
    status.textContent = `${how} Open "In …" under a finding to see where its code is used. Matches are by name, so lists can include unrelated code with the same name.`;
    section.append(status);
  } else if (c?.status === 'running' && (await graphActive(d.run.id))) {
    status.textContent = `Indexing the repository on this device… ${plural(c.files, 'file')} parsed${c.downloadedMB ? `, ${c.downloadedMB} MB downloaded` : ''}.`;
    section.append(status);
  } else if (!c && d.run.headSha && !localTried.has(d.run.id) && (await localModeOn())) {
    askLocal(d);
    status.textContent = 'Asking your local clone where this code is used…';
    section.append(status);
  } else if (!c && localTried.get(d.run.id) === '') {
    status.textContent = 'Asking your local clone where this code is used…';
    section.append(status);
  } else if (!c && (await useSaved(d))) {
    status.textContent = 'Using the index saved on this device for this commit…';
    section.append(status);
  } else {
    const local = localTried.get(d.run.id);
    if (!c && local) section.append(el('p', { className: 'muted', textContent: `Local mode could not help: ${local}` }));
    const why = c?.status === 'failed' ? `Indexing failed: ${c.message}` : c?.status === 'running' ? 'Indexing stopped before it finished, probably because Chrome closed it.' : '';
    if (why) section.append(el('p', { className: 'error', textContent: why }));
    status.textContent = 'Downloads the repository at the reviewed commit and indexes it on this device, to show who calls the code behind each finding. Nothing is sent to the model.';
    section.append(status, el('div', { className: 'actions' }, offer(c ? 'Index again' : 'Show where this code is used')));
  }
  return section;
}

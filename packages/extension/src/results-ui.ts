import { fetchClient, hostFor, type ReviewTarget } from '@repospector/core';
import { contextSection, findingContext } from './context-ui.js';
import { button, el, settingsButton } from './dom.js';
import { markerNote, showMarkers } from './markers-bridge.js';
import type { ReviewFinding, RunRecord } from './pipeline/engine.js';
import { deleteFeedback, feedbackRows, putFeedback, putRun, RUN_CHANNEL, type FeedbackChoice, type FeedbackRow } from './pipeline/store.js';
import { CHOICE_LABELS, feedbackRow } from './review/feedback.js';
import { postFindings, PostError } from './review/post.js';
import { tokenHelp } from './token-help.js';

export interface ResultsContext {
  readonly run: RunRecord;
  readonly target: ReviewTarget;
  readonly apiBase: string;
  readonly hostOrigin: string;
  /** Needed to post; reading public pull requests works without it. */
  readonly hostToken?: string | undefined;
  readonly tabId?: number | undefined;
  readonly again: () => void;
}

const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function feedbackControls(f: ReviewFinding, ctx: ResultsContext, saved: FeedbackRow | undefined): HTMLElement {
  const box = el('div', { className: 'feedback' });
  const where = `${f.file}:${f.line}`;
  const draw = (row: FeedbackRow | undefined): void => {
    const choices = (Object.keys(CHOICE_LABELS) as FeedbackChoice[]).map((c) => {
      const b = button(CHOICE_LABELS[c], () => void choose(row?.choice === c ? undefined : c, ''));
      b.setAttribute('aria-pressed', String(row?.choice === c));
      b.setAttribute('aria-label', `${CHOICE_LABELS[c]}: ${where}`); // visible word first, then which finding
      return b;
    });
    const parts: Node[] = [el('div', { className: 'row-buttons', role: 'group', ariaLabel: `Feedback on ${where}` }, ...choices)];
    if (row && row.choice !== 'useful') {
      const id = `reason-${f.id}`;
      const input = el('input', { id, type: 'text', maxLength: 300, value: row.choice === 'not-relevant' ? row.entry.reason.replace(/^Not relevant here:? ?/, '') : row.entry.reason, placeholder: 'Optional' });
      parts.push(el('label', { htmlFor: id, className: 'muted', textContent: 'Why? Shared if you export feedback.' }), el('div', { className: 'reason' }, input, saveReason(row.choice, input)));
    }
    box.replaceChildren(...parts);
  };
  const saveReason = (choice: FeedbackChoice, input: HTMLInputElement): HTMLButtonElement => {
    const b = button('Save reason', () => void choose(choice, input.value));
    b.setAttribute('aria-label', `Save reason: ${where}`);
    return b;
  };
  const choose = async (choice: FeedbackChoice | undefined, reason: string): Promise<void> => {
    const row = choice ? feedbackRow(f, choice, reason, ctx.target, new Date()) : undefined;
    await (row ? putFeedback(row) : deleteFeedback(f.fingerprint));
    draw(row);
  };
  draw(saved);
  return box;
}

function findingItem(f: ReviewFinding, ctx: ResultsContext, posted: boolean, selected: Set<string>, onSelect: () => void, saved: FeedbackRow | undefined): HTMLLIElement {
  const label = f.status === 'verified' ? 'Verified' : f.status === 'suspected' ? 'Suspected' : 'Not checked';
  const box = el('input', { type: 'checkbox', id: `pick-${f.id}`, checked: selected.has(f.id), disabled: posted });
  box.addEventListener('change', () => {
    if (box.checked) selected.add(f.id);
    else selected.delete(f.id);
    onSelect();
  });
  const pick = el('label', { htmlFor: box.id, className: 'pick' }, box, el('span', { className: 'code', textContent: `${f.file}:${f.line}` }));
  const status = el('span', { className: f.status === 'verified' ? 'label verified' : 'label muted', textContent: posted ? `${label} · in draft` : label });
  const li = el('li', {}, el('div', { className: 'row-head' }, pick, status), el('p', { className: 'claim', textContent: f.claim }));
  if (f.suspectedBecause) li.append(el('p', { className: 'muted', textContent: `Why suspected: ${f.suspectedBecause}` }));
  const where = ctx.run.context?.status === 'done' && ctx.run.headSha ? findingContext(ctx.run.context.perFinding[f.id], ctx.target, ctx.run.headSha) : null;
  if (where) li.append(where);
  li.append(feedbackControls(f, ctx, saved));
  return li;
}

async function post(ctx: ResultsContext, ids: string[], status: HTMLElement, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  status.className = '';
  status.textContent = 'Posting…';
  try {
    const host = hostFor(ctx.target, fetchClient({ kind: ctx.target.kind, base: ctx.apiBase, token: ctx.hostToken }));
    const out = await postFindings(ctx.run, ids, host);
    const done = ids.filter((id) => !out.failed.some((x) => x.findingId === id));
    const run: RunRecord = { ...ctx.run, posted: [...(ctx.run.posted ?? []), { at: Date.now(), url: out.url, findingIds: done }] };
    await putRun(run);
    const channel = new BroadcastChannel(RUN_CHANNEL);
    channel.postMessage({ runId: run.id }); // re-renders this panel and any other open one
    channel.close();
  } catch (e) {
    const s = (e as { status?: number }).status;
    status.className = 'error';
    status.textContent = e instanceof PostError ? e.message : s === 401 || s === 403 || s === 404 ? `${ctx.hostOrigin.replace(/^https:\/\//, '')} refused to post with this token (${s}). ${tokenHelp({ kind: ctx.target.kind, origin: ctx.hostOrigin }).missingScope} Update it in settings.` : `Could not post: ${(e as Error).message}`;
    trigger.disabled = false;
  }
}

function postedNote(run: RunRecord, kind: ReviewTarget['kind']): Node[] {
  const last = run.posted?.at(-1);
  if (!last) return [];
  const where = kind === 'github' ? 'a pending review. Only you can see it until you submit it on GitHub' : 'draft notes. Only you can see them until you publish them on GitLab';
  const link = last.url ? [' ', el('a', { href: last.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open it' })] : [];
  return [el('p', { role: 'status' }, `Posted ${plural(last.findingIds.length, 'finding')} as ${where}.`, ...link)];
}

/** The finished review: findings to select and react to, posting as drafts, and diff markers. */
export async function results(ctx: ResultsContext): Promise<Node[]> {
  const { run } = ctx;
  const findings = run.findings ?? [];
  const count = (s: ReviewFinding['status']) => findings.filter((f) => f.status === s).length;
  const parts = [`${count('verified')} verified`, `${count('suspected')} suspected`, ...(count('unchecked') ? [`${count('unchecked')} not checked`] : [])];
  const cost = run.provider === 'ollama' ? 'no model cost (runs locally)' : run.costUsd === null ? 'cost unknown for this model' : `cost ${money(run.costUsd)}`;
  const out: Node[] = [el('p', { textContent: findings.length ? `${parts.join(', ')}.` : `No issues found in the ${run.filesReviewed ?? 0} changed files reviewed.` }), el('p', { className: 'muted', textContent: `${(run.modelsUsed ?? [run.model]).join(', ')}, ${cost}.` })];
  if (findings.length === 0) return [...out, el('div', { className: 'actions' }, button('Review again', ctx.again))];

  const postedIds = new Set((run.posted ?? []).flatMap((p) => p.findingIds));
  const selected = new Set(findings.filter((f) => f.status === 'verified' && !postedIds.has(f.id)).map((f) => f.id));
  const saved = new Map((await feedbackRows()).map((r) => [r.key, r]));
  const noun = ctx.target.kind === 'github' ? 'a draft review' : 'draft notes';
  const postButton = button('', () => void post(ctx, findings.filter((f) => selected.has(f.id)).map((f) => f.id), status, postButton), true);
  const status = el('p', { role: 'status' });
  const sync = (): void => {
    postButton.textContent = `Post ${plural(selected.size, 'finding')} as ${noun}`;
    postButton.disabled = selected.size === 0;
  };
  sync();

  if (findings.length > 1 && findings.some((f) => f.confidence !== undefined)) out.push(el('p', { className: 'muted', textContent: 'Most likely real defects first; suspected ones at the end.' }));
  const markers = el('p', { className: 'muted' });
  out.push(markers, await contextSection({ run, target: ctx.target, apiBase: ctx.apiBase, hostToken: ctx.hostToken }), el('ol', { className: 'rows findings' }, ...findings.map((f) => findingItem(f, ctx, postedIds.has(f.id), selected, sync, saved.get(f.fingerprint)))));
  out.push(el('p', { className: 'muted', textContent: 'Your feedback stays on this device and lowers similar findings in later reviews. Export it from settings to share it with your team.' }));
  if (run.notes.length) out.push(el('ul', { className: 'notes' }, ...run.notes.map((n) => el('li', { className: 'muted', textContent: n }))));
  out.push(...postedNote(run, ctx.target.kind));
  if (ctx.hostToken) out.push(el('div', { className: 'actions' }, postButton, button('Review again', ctx.again)), status);
  else out.push(el('p', { className: 'muted', textContent: `To post drafts, add an access token for ${ctx.hostOrigin.replace(/^https:\/\//, "")} in settings.` }), el('div', { className: 'actions' }, settingsButton(), button('Review again', ctx.again)));

  if (ctx.tabId !== undefined) void showMarkers(ctx.tabId, ctx.target, findings).then((r) => (markers.textContent = markerNote(r, ctx.target.kind)));
  return out;
}

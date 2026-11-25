import { fetchClient, hostFor, type ReviewTarget } from '@repospector/core';
import { contextSection } from './context-ui.js';
import { button, el, settingsButton } from './dom.js';
import { findingCard } from './finding-card.js';
import { markerNote, showMarkers } from './markers-bridge.js';
import type { ReviewFinding, RunRecord } from './pipeline/engine.js';
import { feedbackRows, putRun, RUN_CHANNEL } from './pipeline/store.js';
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
  /** Review again: only files changed since this review when the pull request has new commits. */
  readonly again: () => void;
  /** Review every file again. */
  readonly full: () => void;
  readonly askFix: (findingId: string) => Promise<void>;
}

const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Notes that limited what was reviewed: shown as a callout above the findings, not in the footer. */
const LIMITING = /^(Repository context was not used|The diff is larger than|The verifier reply could not be read|The repository-context pass reply could not be read|Team rules, linked issues and CI results were not read|The (team-rules|linked-issue) check (reply could not be read|did not run)|Re-review: )/;

async function post(ctx: ResultsContext, ids: string[], status: HTMLElement, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  status.className = '';
  status.textContent = 'Posting…';
  try {
    const host = hostFor(ctx.target, fetchClient({ kind: ctx.target.kind, base: ctx.apiBase, token: ctx.hostToken }));
    const out = await postFindings(ctx.run, ids, host, ctx.target.kind);
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
  return [el('p', { className: 'callout ok', role: 'status' }, `Posted ${plural(last.findingIds.length, 'finding')} as ${where}.`, ...link)];
}

/** Count, status and impact pills, and one line of facts about the run. */
function summary(run: RunRecord, findings: readonly ReviewFinding[]): HTMLElement {
  const count = (s: ReviewFinding['status']) => findings.filter((f) => f.status === s).length;
  const pills: HTMLElement[] = [];
  const pill = (n: number, text: string, cls: string): void => void (n > 0 && pills.push(el('span', { className: `tag ${cls}`, textContent: `${n} ${text}` })));
  pill(count('verified'), 'verified', 'status-verified');
  pill(count('suspected'), 'suspected', 'status-suspected');
  pill(count('unchecked'), 'not checked', 'status-unchecked');
  for (const i of ['high', 'medium', 'low'] as const) pill(findings.filter((f) => f.impact === i).length, `${i} impact`, `impact-${i}`);
  const cost = run.provider === 'ollama' ? 'no model cost (local)' : run.costUsd === null ? 'cost unknown for this model' : money(run.costUsd);
  const facts = [(run.modelsUsed ?? [run.model]).join(', '), cost, plural(run.filesReviewed ?? 0, 'file'), ...(run.repoContext?.definitions ? [`read ${plural(run.repoContext.definitions, 'definition')} from other files`] : [])];
  const title = findings.length ? plural(findings.length, 'finding') : 'No issues found';
  return el('section', { className: 'summary', ariaLabel: 'Review summary' }, el('h2', { textContent: title }), ...(pills.length ? [el('div', { className: 'tags' }, ...pills)] : []), el('p', { className: 'muted', textContent: facts.join(' · ') }));
}

/** What the change does, from the walkthrough pass: overview first, file list folded. */
function walkthrough(run: RunRecord): HTMLElement[] {
  const s = run.summary;
  if (!s) return [];
  const files = s.files.length ? [el('details', {}, el('summary', { textContent: `Changes by file (${s.files.length})` }), el('ul', { className: 'notes' }, ...s.files.map((f) => el('li', {}, el('span', { className: 'code', textContent: f.path }), ` — ${f.change}`))))] : [];
  const focus = s.focus.length ? [el('p', { className: 'muted', textContent: 'Read closely:' }), el('ul', { className: 'notes' }, ...s.focus.map((x) => el('li', { textContent: x })))] : [];
  return [el('section', { className: 'walkthrough', ariaLabel: 'What this change does' }, el('h2', { textContent: 'What this change does' }), el('p', { textContent: s.overview }), ...focus, ...files)];
}

/** The finished review: summary, what limited it, findings to select and react to, then the rest folded away. */
export async function results(ctx: ResultsContext): Promise<Node[]> {
  const { run } = ctx;
  const findings = run.findings ?? [];
  const limiting = run.notes.filter((n) => LIMITING.test(n));
  const other = run.notes.filter((n) => !LIMITING.test(n));
  const out: Node[] = [summary(run, findings), ...walkthrough(run), ...limiting.map((n) => el('p', { className: 'callout warn', role: 'note', textContent: n })), ...postedNote(run, ctx.target.kind)];

  const postedIds = new Set((run.posted ?? []).flatMap((p) => p.findingIds));
  // CI problems already show on the host's diff, and earlier findings were posted before: not pre-selected.
  const selected = new Set(findings.filter((f) => f.status === 'verified' && f.source !== 'ci' && !f.carried && !postedIds.has(f.id)).map((f) => f.id));
  const saved = new Map((await feedbackRows()).map((r) => [r.key, r]));
  const noun = ctx.target.kind === 'github' ? 'a draft review' : 'draft notes';
  const status = el('p', { role: 'status' });
  const postButton = button('', () => void post(ctx, findings.filter((f) => selected.has(f.id)).map((f) => f.id), status, postButton), true);
  const sync = (): void => {
    postButton.textContent = `Post ${plural(selected.size, 'finding')} as ${noun}`;
    postButton.disabled = selected.size === 0;
  };
  sync();
  if (findings.length) out.push(el('ol', { className: 'findings', ariaLabel: 'Findings' }, ...findings.map((f) => findingCard(f, { run, target: ctx.target, askFix: ctx.askFix }, postedIds.has(f.id), selected, sync, saved.get(f.fingerprint)))));

  // Secondary information, folded: ordering, page markers, where code is used, other notes.
  const markers = el('p', { className: 'muted' });
  const about: Node[] = [];
  if (findings.length > 1) about.push(el('p', { className: 'muted', textContent: 'Most likely real defects first; suspected ones at the end.' }));
  if (findings.length) about.push(markers, await contextSection({ run, target: ctx.target, apiBase: ctx.apiBase, hostToken: ctx.hostToken }), el('p', { className: 'muted', textContent: 'Your feedback stays on this device and lowers similar findings in later reviews. Export it from settings to share it with your team.' }));
  if (other.length) about.push(el('ul', { className: 'notes' }, ...other.map((n) => el('li', { className: 'muted', textContent: n }))));
  if (about.length) out.push(el('details', { className: 'about' }, el('summary', { textContent: 'About this review' }), ...about));

  // Actions stay in view at the bottom of the panel.
  const again = [button('Review again', ctx.again, !findings.length), button('Review all files', ctx.full)];
  again[0]!.title = 'If the pull request has new commits, only the files they change are reviewed; earlier findings in other files are kept.';
  const actions = ctx.hostToken && findings.length ? [postButton, ...again] : [...again, ...(findings.length ? [settingsButton()] : [])];
  const hint = !ctx.hostToken && findings.length ? [el('p', { className: 'muted', textContent: `To post drafts, add an access token for ${ctx.hostOrigin.replace(/^https:\/\//, '')} in settings.` })] : [];
  out.push(el('div', { className: 'actionbar' }, ...hint, el('div', { className: 'actions' }, ...actions), status));

  if (ctx.tabId !== undefined && findings.length) void showMarkers(ctx.tabId, ctx.target, findings).then((r) => (markers.textContent = markerNote(r, ctx.target.kind)));
  return out;
}

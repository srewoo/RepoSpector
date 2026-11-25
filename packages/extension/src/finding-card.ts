import type { ReviewTarget } from '@repospector/core';
import { findingContext } from './context-ui.js';
import { button, el } from './dom.js';
import type { ReviewFinding, RunRecord } from './pipeline/engine.js';
import { deleteFeedback, putFeedback, type FeedbackChoice, type FeedbackRow } from './pipeline/store.js';
import { feedbackRow } from './review/feedback.js';

/** Short button words; the stored reason keeps its own wording (review/feedback.ts). */
const CHOICES: Record<FeedbackChoice, string> = { useful: 'Useful', 'not-useful': 'Not useful', 'not-relevant': 'Not relevant' };
const IMPACT_TEXT = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' } as const;
const STATUS_TEXT = { verified: 'Verified', suspected: 'Suspected', unchecked: 'Not checked' } as const;

export interface CardContext {
  readonly run: RunRecord;
  readonly target: ReviewTarget;
  /** Asks the worker for a suggested fix; the card re-renders when the run record updates. */
  readonly askFix?: ((findingId: string) => Promise<void>) | undefined;
}

const SOURCE_TAG = {
  rules: ['Team rule', 'Found by checking the change against the team rules files at the pull request base'],
  requirements: ['Linked issue', 'Found by comparing the change with the issue it links'],
  ci: ['From CI', 'Reported by a CI check on a line this change adds'],
} as const;

/** The suggested change, or a button that asks for one, or why there is none. */
function fixBlock(f: ReviewFinding, ctx: CardContext): HTMLElement | null {
  if (f.fix) {
    const lines = f.fix.startLine === f.fix.endLine ? `line ${f.fix.startLine}` : `lines ${f.fix.startLine}–${f.fix.endLine}`;
    return el('details', { className: 'fix' }, el('summary', { textContent: `Suggested fix (${lines})` }), ...(f.fix.explanation ? [el('p', { className: 'muted', textContent: f.fix.explanation })] : []), el('pre', { className: 'code' }, el('code', { textContent: f.fix.replacement || '(delete these lines)' })), el('p', { className: 'muted', textContent: 'Posted with the finding as a suggestion the author can apply in one click.' }));
  }
  if (f.source === 'ci' || f.carried || !ctx.askFix) return null;
  const note = el('p', { className: 'muted', role: 'status', textContent: f.fixUnavailable ? `No fix suggested: ${f.fixUnavailable}.` : '' });
  const ask = button(f.fixUnavailable ? 'Try a fix again' : 'Suggest a fix', () => {
    ask.disabled = true;
    note.textContent = 'Suggesting a fix… (one model call)';
    ctx.askFix?.(f.id).catch((e: unknown) => {
      ask.disabled = false;
      note.textContent = `Could not ask for a fix: ${(e as Error).message}`;
    });
  });
  ask.setAttribute('aria-label', `Suggest a fix: ${f.file}:${f.line}`);
  return el('div', { className: 'fix' }, ask, note);
}

/** How bad the finding is if real. The word carries the meaning; colour only supports it. */
function impactTag(impact: NonNullable<ReviewFinding['impact']>): HTMLSpanElement {
  const tag = el('span', { className: `tag impact-${impact}`, textContent: IMPACT_TEXT[impact] });
  tag.title = impact === 'high' ? 'Security, data loss, crash, or a main feature broken' : impact === 'medium' ? 'Wrong in some cases, or has a workaround' : 'Rare, minor or cosmetic';
  return tag;
}

/** "packages/a/src/b.ts" → name "b.ts", folder "packages/a/src/". */
function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return { name: path.slice(i + 1), dir: i >= 0 ? path.slice(0, i + 1) : '' };
}

function feedbackControls(f: ReviewFinding, ctx: CardContext, saved: FeedbackRow | undefined): HTMLElement {
  const box = el('div', { className: 'feedback' });
  const where = `${f.file}:${f.line}`;
  const draw = (row: FeedbackRow | undefined): void => {
    const choices = (Object.keys(CHOICES) as FeedbackChoice[]).map((c) => {
      const b = button(CHOICES[c], () => void choose(row?.choice === c ? undefined : c, ''));
      b.setAttribute('aria-pressed', String(row?.choice === c));
      b.setAttribute('aria-label', `${CHOICES[c]}: ${where}`); // visible word first, then which finding
      return b;
    });
    const parts: Node[] = [el('div', { className: 'segmented', role: 'group', ariaLabel: `Feedback on ${where}` }, ...choices)];
    if (row && row.choice !== 'useful') {
      const id = `reason-${f.id}`;
      const input = el('input', { id, type: 'text', maxLength: 300, value: row.choice === 'not-relevant' ? row.entry.reason.replace(/^Not relevant here:? ?/, '') : row.entry.reason, placeholder: 'Optional' });
      const save = button('Save reason', () => void choose(row.choice, input.value));
      save.setAttribute('aria-label', `Save reason: ${where}`);
      parts.push(el('label', { htmlFor: id, className: 'muted', textContent: 'Why? Shared if you export feedback.' }), el('div', { className: 'reason' }, input, save));
    }
    box.replaceChildren(...parts);
  };
  const choose = async (choice: FeedbackChoice | undefined, reason: string): Promise<void> => {
    const row = choice ? feedbackRow(f, choice, reason, ctx.target, new Date()) : undefined;
    await (row ? putFeedback(row) : deleteFeedback(f.fingerprint));
    draw(row);
  };
  draw(saved);
  return box;
}

/**
 * One finding: pick box with the file name and line (the part people scan for), its folder below,
 * tags (impact, status, found with repository code), the claim, the suspicion reason folded away,
 * where its code is used, and feedback.
 */
export function findingCard(f: ReviewFinding, ctx: CardContext, posted: boolean, selected: Set<string>, onSelect: () => void, saved: FeedbackRow | undefined): HTMLLIElement {
  const box = el('input', { type: 'checkbox', id: `pick-${f.id}`, checked: selected.has(f.id), disabled: posted });
  box.addEventListener('change', () => {
    if (box.checked) selected.add(f.id);
    else selected.delete(f.id);
    onSelect();
  });
  const { name, dir } = splitPath(f.file);
  const file = el('span', { className: 'file' }, el('span', { className: 'name', textContent: name }), el('span', { className: 'line', textContent: `:${f.line}` }));
  const pick = el('label', { htmlFor: box.id, className: 'pick' }, box, file);
  pick.title = `${f.file}:${f.line}`;
  const status = el('span', { className: `tag status-${f.status}`, textContent: posted ? `${STATUS_TEXT[f.status]} · in draft` : STATUS_TEXT[f.status] });
  const extra: HTMLElement[] = [];
  if (f.fromContext) extra.push(el('span', { className: 'tag', textContent: 'Used code from other files', title: 'Found by the review pass that read the code this change calls' }));
  if (f.source) extra.push(el('span', { className: 'tag', textContent: SOURCE_TAG[f.source][0], title: SOURCE_TAG[f.source][1] }));
  if (f.carried) extra.push(el('span', { className: 'tag', textContent: 'From earlier review', title: 'Found by the previous review in a file the new commits did not change' }));
  const tags = el('div', { className: 'tags' }, ...(f.impact ? [impactTag(f.impact)] : []), status, ...extra);
  const li = el('li', { className: `finding${f.status === 'suspected' ? ' is-suspected' : ''}` }, pick);
  if (dir) li.append(el('p', { className: 'path code', textContent: dir }));
  li.append(tags, el('p', { className: 'claim', textContent: f.claim }));
  if (f.suspectedBecause) li.append(el('details', { className: 'why' }, el('summary', { textContent: 'Why suspected' }), el('p', { textContent: f.suspectedBecause })));
  const where = ctx.run.context?.status === 'done' && ctx.run.headSha ? findingContext(ctx.run.context.perFinding[f.id], ctx.target, ctx.run.headSha) : null;
  if (where) li.append(where);
  const fix = fixBlock(f, ctx);
  if (fix) li.append(fix);
  li.append(feedbackControls(f, ctx, saved));
  return li;
}

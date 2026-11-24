import { el } from './dom.js';
import type { Step } from './pipeline/engine.js';

const STEPS: readonly { readonly step: Step; readonly label: string }[] = [
  { step: 'fetch', label: 'Read the pull request' },
  { step: 'context', label: 'Read the repository for the code this change calls' },
  { step: 'review', label: 'Review the changes' },
  { step: 'verify', label: 'Check each finding with a second pass' },
  { step: 'filter', label: 'Apply your team\'s feedback' },
];

/** "45 s", "2 min 05 s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

export interface ProgressView {
  readonly nodes: Node[];
  /** Stops the elapsed-time ticker. Call before the view is replaced. */
  readonly stop: () => void;
}

/**
 * Stepped progress for a running review. Model calls report no partial progress, so the bar shows
 * finished steps (filled) and the current one (moving stripe), never a made-up percentage.
 */
export function progressView(current: Step, model: string, startedAt: number, now: () => number = Date.now): ProgressView {
  const index = Math.max(0, STEPS.findIndex((s) => s.step === current));
  const label = (i: number): string => (STEPS[i]?.step === 'review' ? `${STEPS[i]?.label} with ${model}, with and without that code` : (STEPS[i]?.label ?? ''));
  const bar = el('div', { className: 'progress' });
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(STEPS.length));
  bar.setAttribute('aria-valuenow', String(index));
  bar.setAttribute('aria-valuetext', `Step ${index + 1} of ${STEPS.length}: ${label(index)}`);
  bar.setAttribute('aria-label', 'Review progress');
  for (let i = 0; i < STEPS.length; i++) bar.append(el('span', { className: i < index ? 'seg done' : i === index ? 'seg active' : 'seg' }));

  const elapsed = el('span', { className: 'muted' });
  const tick = (): void => void (elapsed.textContent = `${elapsedText(now() - startedAt)} elapsed`);
  tick();
  const timer = setInterval(tick, 1000);

  const head = el('p', { className: 'progress-head' }, el('strong', { textContent: `Step ${index + 1} of ${STEPS.length}` }), elapsed);
  const list = el(
    'ol',
    { className: 'steps' },
    ...STEPS.map((_, i) =>
      el('li', { className: i < index ? 'done' : i === index ? 'active' : '' }, el('span', { className: 'mark', textContent: i < index ? '✓' : i === index ? '●' : '○', ariaHidden: 'true' }), `${label(i)}${i === index ? '…' : ''}`),
    ),
  );
  return { nodes: [bar, head, list], stop: () => clearInterval(timer) };
}

import { button, el } from './dom.js';
import { vault } from './keys-ui.js';
import { VaultError, type VaultStatus } from './vault.js';

/** Turns any failure into a sentence for the user. */
export const message = (e: unknown): string => (e instanceof VaultError ? `Could not save: ${e.message}.` : e instanceof Error ? e.message : 'Something went wrong.');

export interface StatusLine {
  readonly node: HTMLParagraphElement;
  busy(text: string): void;
  ok(text: string): void;
  error(text: string): void;
  clear(): void;
}

/** The result line under a Check button: grey while working, plain when it worked, red when it failed. */
export function statusLine(id: string): StatusLine {
  const node = el('p', { id, className: 'row-status', role: 'status' });
  node.hidden = true;
  const set = (cls: string, text: string): void => {
    node.hidden = false;
    node.className = `row-status ${cls}`;
    node.textContent = text;
  };
  return { node, busy: (t) => set('muted', t), ok: (t) => set('ok', t), error: (t) => set('error', t), clear: () => ((node.hidden = true), (node.textContent = '')) };
}

export interface Protection {
  /** Passphrase fields (first save only); empty once keys are protected. */
  readonly nodes: Node[];
  /** A sentence saying what to fix, or null when the fields are fine. */
  validate(): string | null;
  /** Creates the vault if needed. Call only after the secret checked out, so a wrong key leaves nothing behind. */
  ensure(): Promise<boolean>;
}

/**
 * First save only: a passphrase that encrypts keys on this device, or memory only. `idPrefix`
 * keeps ids unique when two forms on the page show it.
 */
export function protection(status: VaultStatus, idPrefix: string): Protection {
  if (status !== 'none') return { nodes: [], validate: () => null, ensure: async () => false };
  const field = (id: string, label: string): [HTMLLabelElement, HTMLInputElement] => [el('label', { htmlFor: id, textContent: label }), el('input', { id, name: id, type: 'password', autocomplete: 'new-password' })];
  const [l1, p1] = field(`${idPrefix}-pass1`, 'Choose a passphrase to encrypt your keys (at least 10 characters)');
  const [l2, p2] = field(`${idPrefix}-pass2`, 'Repeat passphrase');
  const memory = el('input', { id: `${idPrefix}-memory`, type: 'checkbox' });
  const memoryLabel = el('label', { htmlFor: `${idPrefix}-memory`, className: 'pick' }, memory, 'Don\'t store keys on this device: keep them in memory until Chrome closes');
  const passBox = el('div', {}, l1, p1, l2, p2);
  memory.addEventListener('change', () => (passBox.hidden = memory.checked));
  return {
    nodes: [el('p', { className: 'muted', textContent: 'First key: it is encrypted on this device with a passphrase you choose. You enter the passphrase once per browser session.' }), passBox, memoryLabel],
    validate: () => {
      if (memory.checked) return null;
      if (p1.value.length < 10) return 'Choose a passphrase of at least 10 characters, or tick "Don\'t store keys on this device".';
      if (p1.value !== p2.value) return 'The two passphrases do not match.';
      return null;
    },
    ensure: async () => {
      // Another form on the page may have created it meanwhile.
      if ((await vault.status()) !== 'none') return false;
      await (memory.checked ? vault.useSessionOnly() : vault.setup(p1.value));
      return true;
    },
  };
}

/** Shown instead of a key form while keys are locked. */
export function unlockBlock(idPrefix: string, what: string, done: () => void): Node[] {
  const id = `${idPrefix}-unlock`;
  const input = el('input', { id, name: id, type: 'password', autocomplete: 'current-password' });
  const status = statusLine(`${id}-status`);
  const go = (): void => {
    status.busy('Unlocking…');
    void vault.unlock(input.value).then(done, (e: unknown) => status.error(e instanceof VaultError && e.message === 'wrong passphrase' ? 'That passphrase is not right. Try again.' : message(e)));
  };
  input.addEventListener('keydown', (ev) => ev.key === 'Enter' && (ev.preventDefault(), go()));
  return [el('p', { textContent: `Your keys are locked. Enter your passphrase to ${what}.` }), el('label', { htmlFor: id, textContent: 'Passphrase' }), input, el('div', { className: 'actions' }, button('Unlock keys', go, true)), status.node];
}

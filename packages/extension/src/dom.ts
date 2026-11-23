/** Small DOM helpers shared by the extension pages. Text goes in through textContent only. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label, ...(primary ? { className: 'primary' } : {}) });
  b.addEventListener('click', onClick);
  return b;
}

export const settingsButton = (): HTMLButtonElement => button('Open settings', () => void chrome.runtime.openOptionsPage());

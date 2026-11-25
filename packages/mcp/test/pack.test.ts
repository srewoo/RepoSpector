import { describe, expect, it } from 'vitest';
import { buildPages } from '../src/pack.js';

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

describe('buildPages', () => {
  it('keeps a small pack on one page with the preface outside the untrusted block', () => {
    const pages = buildPages([
      { kind: 'diff', parts: ['a\n', 'b\n'] },
      { kind: 'definitions', parts: ['### `f` at x.ts:1\n'], preface: 'Use the definitions.' },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/Use the definitions\.\n<untrusted-repo-content kind="definitions">/);
  });

  it('splits by size, never past the limit by more than one wrapper, with every block closed on its page', () => {
    const parts = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(998)}\n`);
    const pages = buildPages([{ kind: 'diff', parts }], 5_000);
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) {
      expect(p.length).toBeLessThan(5_200);
      expect(count(p, /<untrusted-repo-content kind=/g)).toBe(count(p, /<\/untrusted-repo-content>/g));
    }
    // Nothing lost, in order.
    const joined = pages.join('');
    expect(parts.every((part) => joined.includes(part))).toBe(true);
    expect(joined.indexOf('00x')).toBeLessThan(joined.indexOf('29x'));
  });

  it('splits one part longer than a page into consecutive blocks', () => {
    const pages = buildPages([{ kind: 'diff', parts: ['y'.repeat(12_000)] }], 5_000);
    expect(pages).toHaveLength(3);
    expect(pages.join('').split('y').length - 1).toBe(12_000);
  });
});

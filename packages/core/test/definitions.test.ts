import { describe, expect, it } from 'vitest';
import type { FileSymbols } from '../src/graph/extract.js';
import { definitionsText, locateDefinitions, MAX_DEFS_PER_NAME } from '../src/review/definitions.js';

const fn = (name: string, nameLine: number) => ({ name, kind: 'function' as const, startLine: nameLine, endLine: nameLine + 5, nameLine });
const sym = (...defs: ReturnType<typeof fn>[]): FileSymbols => ({ language: 'typescript', defs, calls: [], inherits: [] });

describe('repository definitions for the context pass', () => {
  it('finds where called names are defined, skipping tests and definitions the diff itself adds', () => {
    const files = new Map<string, FileSymbols>([
      ['src/store.ts', sym(fn('saveUser', 12), fn('loadUser', 30))],
      ['src/store.test.ts', sym(fn('saveUser', 3))],
      ['src/new.ts', sym(fn('addedHere', 5))],
    ]);
    const added = new Map([['src/new.ts', new Set([5])]]);
    const r = locateDefinitions(files, ['saveUser', 'addedHere', 'fetchJson'], added);
    expect(r.found).toEqual([{ name: 'saveUser', file: 'src/store.ts', line: 12 }]);
    expect(r.missing).toEqual(['addedHere', 'fetchJson']);
  });

  it('matches JS/TS private methods (indexed as #name, called as this.#name())', () => {
    const files = new Map<string, FileSymbols>([['source/core/Ky.ts', sym(fn('#getRemainingTotalTimeout', 210))]]);
    expect(locateDefinitions(files, ['getRemainingTotalTimeout'], new Map()).found).toEqual([{ name: 'getRemainingTotalTimeout', file: 'source/core/Ky.ts', line: 210 }]);
  });

  it('leaves out names defined in too many places rather than guessing', () => {
    const files = new Map<string, FileSymbols>(Array.from({ length: MAX_DEFS_PER_NAME + 1 }, (_, i) => [`m${i}.ts`, sym(fn('handle', 1))]));
    const r = locateDefinitions(files, ['handle'], new Map());
    expect(r.ambiguous).toEqual(['handle']);
    expect(r.found).toEqual([]);
  });

  it('writes each definition\'s first 20 lines, masks secrets, skips unreadable files, and respects the size cap', () => {
    const body = Array.from({ length: 30 }, (_, i) => (i === 1 ? '  const key = "AKIAABCDEFGHIJKLMNOP";' : `  line ${i + 1}`)).join('\n');
    const sites = [{ name: 'saveUser', file: 'src/store.ts', line: 1 }, { name: 'gone', file: 'missing.ts', line: 1 }];
    const { text, used } = definitionsText(sites, (f) => (f === 'src/store.ts' ? body : undefined));
    expect(used.map((u) => u.name)).toEqual(['saveUser']);
    expect(text.startsWith('### `saveUser` at src/store.ts:1\n```\n')).toBe(true);
    expect(text).toContain('line 20');
    expect(text).not.toContain('line 21');
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(definitionsText(sites, () => body, 50).used).toEqual([]);
  });
});

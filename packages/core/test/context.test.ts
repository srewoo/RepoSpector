import { describe, expect, it } from 'vitest';
import { buildContextPack, type UsageHit } from '../src/context.js';
import type { ChangedSymbol } from '../src/symbols.js';

const sym = (name: string, change: ChangedSymbol['change'] = 'defined', file = 'src/a.ts'): ChangedSymbol => ({ name, change, file });
const hit = (file: string, line: number, symbol: string, snippet = `  ${symbol}(x)`): UsageHit => ({ file, line, symbol, snippet });

describe('buildContextPack', () => {
  it('drops hits inside lines the diff changed, keeps hits elsewhere in the same file', () => {
    const changed = new Map([['src/a.ts', new Set([10, 11])]]);
    const pack = buildContextPack([sym('foo')], [hit('src/a.ts', 10, 'foo'), hit('src/a.ts', 40, 'foo')], changed);
    expect(pack.hits.map((h) => h.line)).toEqual([40]);
  });

  it('prefers files outside the diff and non-test files, and caps hits per symbol', () => {
    const changed = new Map([['src/a.ts', new Set<number>()]]);
    const hits = [
      hit('src/a.ts', 5, 'foo'),
      hit('test/a.test.ts', 5, 'foo'),
      ...Array.from({ length: 10 }, (_, i) => hit(`src/caller${i}.ts`, i + 1, 'foo')),
    ];
    const pack = buildContextPack([sym('foo')], hits, changed, { perSymbol: 4 });
    expect(pack.hits).toHaveLength(4);
    expect(pack.hits.every((h) => h.file.startsWith('src/caller'))).toBe(true);
    expect(pack.omitted).toBe(8);
  });

  it('formats a pack within the character budget, removed symbols first, and reports what did not fit', () => {
    const big = 'x'.repeat(400);
    const pack = buildContextPack(
      [sym('kept', 'defined'), sym('gone', 'removed')],
      [hit('src/b.ts', 1, 'kept', big), hit('src/c.ts', 2, 'gone', big), hit('src/d.ts', 3, 'kept', big)],
      new Map(),
      { maxChars: 1000 },
    );
    expect(pack.text.length).toBeLessThanOrEqual(1000);
    expect(pack.text.indexOf('gone')).toBeLessThan(pack.text.indexOf('kept'));
    expect(pack.text).toContain('src/c.ts:2');
    expect(pack.omitted).toBeGreaterThan(0);
  });

  it('returns an empty pack when nothing is used elsewhere', () => {
    expect(buildContextPack([sym('foo')], [], new Map())).toEqual({ text: '', hits: [], omitted: 0 });
  });
});

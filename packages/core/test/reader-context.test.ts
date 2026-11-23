import { describe, expect, it } from 'vitest';
import type { FileSymbols } from '../src/graph/extract.js';
import { isIndexable, readerContext } from '../src/graph/reader-context.js';

const files = new Map<string, FileSymbols>([
  [
    'src/cart.ts',
    {
      language: 'typescript',
      defs: [
        { name: 'Cart', kind: 'class', startLine: 1, endLine: 20, nameLine: 1 },
        { name: 'total', kind: 'method', startLine: 3, endLine: 9, nameLine: 3 },
      ],
      calls: [{ name: 'total', line: 6, caller: 'total' }], // recursion: not a caller
      inherits: [],
    },
  ],
  ['src/checkout.ts', { language: 'typescript', defs: [{ name: 'pay', kind: 'function', startLine: 1, endLine: 5, nameLine: 1 }], calls: [{ name: 'total', line: 3, caller: 'pay' }], inherits: [] }],
  ['src/a.ts', { language: 'typescript', defs: [], calls: [{ name: 'total', line: 9 }], inherits: [{ child: 'GiftCart', base: 'Cart', line: 2 }] }],
  ['src/other.ts', { language: 'typescript', defs: [{ name: 'total', kind: 'function', startLine: 4, endLine: 6, nameLine: 4 }], calls: [], inherits: [] }],
]);

describe('readerContext', () => {
  it('finds the innermost definition around the line, its callers by name, same-name definitions', () => {
    const ctx = readerContext(files, [{ id: 'f1', file: 'src/cart.ts', line: 5 }]).f1;
    expect(ctx?.symbol).toEqual({ name: 'total', kind: 'method', file: 'src/cart.ts', startLine: 3, endLine: 9 });
    expect(ctx?.callers).toEqual([{ file: 'src/a.ts', line: 9 }, { file: 'src/checkout.ts', line: 3, caller: 'pay' }]);
    expect(ctx?.callerCount).toBe(2);
    expect(ctx?.sameName).toEqual([{ file: 'src/other.ts', line: 4, kind: 'function' }]);
    expect(ctx?.subtypes).toEqual([]);
  });

  it('lists subclasses for a class', () => {
    const ctx = readerContext(files, [{ id: 'f2', file: 'src/cart.ts', line: 15 }]).f2;
    expect(ctx?.symbol.name).toBe('Cart');
    expect(ctx?.subtypes).toEqual([{ file: 'src/a.ts', line: 2, name: 'GiftCart' }]);
  });

  it('gives no context for a line outside any definition, or a file not indexed', () => {
    expect(readerContext(files, [{ id: 'f3', file: 'src/a.ts', line: 1 }, { id: 'f4', file: 'nope.ts', line: 1 }])).toEqual({});
  });
});

describe('isIndexable', () => {
  it('keeps supported source and drops generated, vendored, secret, unsupported and oversized files', () => {
    expect(isIndexable('src/a.py', 100)).toBe(true);
    expect(isIndexable('node_modules/x/index.js', 100)).toBe(false);
    expect(isIndexable('dist/app.js', 100)).toBe(false);
    expect(isIndexable('README.md', 100)).toBe(false);
    expect(isIndexable('src/a.py', 2 * 1024 * 1024)).toBe(false);
    expect(isIndexable('../etc/passwd.py', 10)).toBe(false);
  });
});

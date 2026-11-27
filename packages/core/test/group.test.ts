import { describe, expect, it } from 'vitest';
import { foldSameCause } from '../src/review/group.js';

const items = [
  { file: 'a', line: 1, confidence: 50 },
  { file: 'b', line: 9, confidence: 80 },
  { file: 'c', line: 3, confidence: 40 },
];

describe('foldSameCause', () => {
  it('folds members into the highest-confidence member and lists the other sites', () => {
    const out = foldSameCause(items, new Map([[1, 0], [2, 0]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'b', line: 9, alsoAt: [{ file: 'a', line: 1 }, { file: 'c', line: 3 }] });
  });

  it('keeps the head at the position of the first group member', () => {
    const out = foldSameCause([{ file: 'x', line: 1 }, ...items], new Map([[3, 1]]));
    expect(out.map((f) => f.file)).toEqual(['x', 'a', 'b']);
    expect(out[1]).toMatchObject({ file: 'a', alsoAt: [{ file: 'c', line: 3 }] });
  });

  it('ignores self, forward, out-of-range and chained links', () => {
    expect(foldSameCause(items, new Map([[0, 0]]))).toHaveLength(3);
    expect(foldSameCause(items, new Map([[0, 2]]))).toHaveLength(3);
    expect(foldSameCause(items, new Map([[7, 1]]))).toHaveLength(3);
    // 2 → 1 is ignored because 1 is itself a member of 0's group.
    expect(foldSameCause(items, new Map([[1, 0], [2, 1]]))).toHaveLength(2);
  });

  it('returns the items unchanged without links', () => {
    expect(foldSameCause(items, new Map())).toEqual(items);
  });
});

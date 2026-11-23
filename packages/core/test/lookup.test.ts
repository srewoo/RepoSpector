import { describe, expect, it } from 'vitest';
import { classifyHits } from '../src/lookup.js';

const h = (file: string, line: number, text: string) => ({ file, line, text });

describe('classifyHits', () => {
  it('splits definitions from uses, non-test definitions first', () => {
    const r = classifyHits('getOrCreateResource', [
      h('src/Caller.java', 40, '    schema.getOrCreateResource(session, client);'),
      h('src/test/FakeSchema.java', 3, '  public Resource getOrCreateResource(Session s, Client c) {'),
      h('src/Schema.java', 12, '  public Resource getOrCreateResource(Session s, Client c) {'),
    ]);
    expect(r.definitions.map((d) => d.file)).toEqual(['src/Schema.java', 'src/test/FakeSchema.java']);
    expect(r.usages.map((u) => u.file)).toEqual(['src/Caller.java']);
  });

  it('finds definitions of generic names when asked for one explicitly', () => {
    const r = classifyHits('update', [h('a.py', 1, 'def update(self, x):'), h('b.py', 2, 'obj.update(1)')]);
    expect(r.definitions).toHaveLength(1);
    expect(r.usages).toHaveLength(1);
  });

  it('does not count a line that defines a different name', () => {
    const r = classifyHits('total', [h('a.js', 1, 'function subtotal(total) {')]);
    expect(r.definitions).toEqual([]);
    expect(r.usages).toHaveLength(1);
  });
});

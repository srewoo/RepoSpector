import { describe, expect, it } from 'vitest';
import { calledNames } from '../src/callees.js';
import { definitionName } from '../src/symbols.js';

const diff = (path: string, body: string): string =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

describe('calledNames', () => {
  it('collects calls, method calls, constructors, base classes and JSX components from added lines only', () => {
    const text =
      diff('a.py', '@@ -1,2 +1,3 @@\n-    old_helper(x)\n+class BrowserReportingEndpoint(Endpoint):\n+    resolve_dataset(scoped, query)\n') +
      diff('b.ts', '@@ -1,1 +1,3 @@\n+const r = new PermissionResolver(cfg);\n+authz.getOrCreateResource(id);\n+return <RuleActionsButtons rule={x} />;\n');
    const names = calledNames(text);
    expect(names).toEqual(expect.arrayContaining(['Endpoint', 'resolve_dataset', 'PermissionResolver', 'getOrCreateResource', 'RuleActionsButtons']));
    expect(names).not.toContain('old_helper');
    expect(names).not.toContain('BrowserReportingEndpoint');
  });

  it('skips keywords, builtins, short names and names defined by the diff itself', () => {
    const text = diff('a.ts', '@@ -0,0 +1,5 @@\n+function buildThing() {}\n+if (ok) print(len(xs));\n+items.map(fn).push(1);\n+console.log(buildThing());\n+  return foo(1);\n');
    expect(calledNames(text)).toEqual([]);
  });

  it('skips test files and orders by number of uses', () => {
    const text =
      diff('tests/test_a.py', '@@ -0,0 +1,1 @@\n+    make_fixture_thing()\n') +
      diff('a.go', '@@ -0,0 +1,3 @@\n+\tonceCalled(x)\n+\ttwiceCalled(y)\n+\ttwiceCalled(z)\n');
    expect(calledNames(text)).toEqual(['twiceCalled', 'onceCalled']);
  });
});

describe('definitionName', () => {
  it('recognises the definition of a given name across languages', () => {
    expect(definitionName('    def resolve_dataset(self, q):', 'x.py')).toBe('resolve_dataset');
    expect(definitionName('func (s *Store) getOrCreateResource(id string) error {', 'x.go')).toBe('getOrCreateResource');
    expect(definitionName('class Endpoint(APIView):', 'x.py')).toBe('Endpoint');
    expect(definitionName('    resolve_dataset(scoped, q)', 'x.py')).toBeNull();
  });
});

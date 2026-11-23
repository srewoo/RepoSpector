import { describe, expect, it } from 'vitest';
import { extractSymbols, languageFor } from '../src/graph/parser.js';

const defs = (r: Awaited<ReturnType<typeof extractSymbols>>) => r?.defs.map((d) => `${d.kind} ${d.name} ${d.startLine}-${d.endLine}`);
const calls = (r: Awaited<ReturnType<typeof extractSymbols>>) => r?.calls.map((c) => `${c.name}@${c.line}<${c.caller ?? '-'}`);

describe('languageFor', () => {
  it('maps extensions and returns undefined for unsupported files', () => {
    expect(languageFor('a/b.py')).toBe('python');
    expect(languageFor('x.tsx')).toBe('tsx');
    expect(languageFor('x.mts')).toBe('typescript');
    expect(languageFor('README.md')).toBeUndefined();
  });
});

describe('extractSymbols', () => {
  it('python: classes, methods, calls with their caller', async () => {
    const r = await extractSymbols('a.py', 'class Svc(Base):\n    def run(self, x):\n        return helper(x).save()\n\ndef helper(x):\n    return x\n');
    expect(defs(r)).toEqual(['class Svc 1-3', 'method run 2-3', 'function helper 5-6']);
    expect(calls(r)).toEqual(['helper@3<run', 'save@3<run']);
  });

  it('go: functions, methods, types', async () => {
    const r = await extractSymbols('a.go', 'package a\n\ntype Store struct{}\n\nfunc (s *Store) Get(id string) error {\n\treturn fetch(id)\n}\n\nfunc fetch(id string) error { return s.client.Do(id) }\n');
    expect(defs(r)).toEqual(['type Store 3-3', 'method Get 5-7', 'function fetch 9-9']);
    expect(calls(r)).toEqual(['fetch@6<Get', 'Do@9<fetch']);
  });

  it('java: class, constructor, method, calls and constructions', async () => {
    const r = await extractSymbols('A.java', 'class A extends B {\n  A() { init(); }\n  int f(int x) {\n    return new Helper().g(x);\n  }\n}\n');
    expect(defs(r)).toEqual(['class A 1-6', 'method A 2-2', 'method f 3-5']);
    expect(calls(r)).toEqual(['init@2<A', 'Helper@4<f', 'g@4<f']);
  });

  it('ruby: class, methods, calls', async () => {
    const r = await extractSymbols('a.rb', 'class Topic < Base\n  def visible_ids(user)\n    scope_for(user).pluck(:id)\n  end\nend\n');
    expect(defs(r)).toEqual(['class Topic 1-5', 'method visible_ids 2-4']);
    expect(calls(r)).toEqual(['scope_for@3<visible_ids', 'pluck@3<visible_ids']);
  });

  it('typescript and tsx: functions, arrow consts, classes, interfaces, JSX components', async () => {
    const ts = await extractSymbols('a.ts', 'export interface Opts { a: number }\nexport const build = (o: Opts) => make(o);\nclass Q { run() { return this.exec(); } }\nfunction make(o: Opts) { return new Q(); }\n');
    expect(defs(ts)).toEqual(['type Opts 1-1', 'function build 2-2', 'class Q 3-3', 'method run 3-3', 'function make 4-4']);
    expect(calls(ts)).toEqual(['make@2<build', 'exec@3<run', 'Q@4<make']);
    const tsx = await extractSymbols('a.tsx', 'export function Page() {\n  return <Dialog open onClose={close} />;\n}\n');
    expect(calls(tsx)).toEqual(['Dialog@2<Page']);
  });

  it('records extends and implements links', async () => {
    const inh = (r: Awaited<ReturnType<typeof extractSymbols>>) => r?.inherits.map((i) => `${i.child}<${i.base}@${i.line}`);
    expect(inh(await extractSymbols('a.py', 'class A(Base, mixins.Audited):\n    pass\n'))).toEqual(['A<Base@1', 'A<Audited@1']);
    expect(inh(await extractSymbols('A.java', 'class A extends B implements C, D<E> {}\ninterface I extends J {}\n'))).toEqual(['A<B@1', 'A<C@1', 'A<D@1', 'I<J@2']);
    expect(inh(await extractSymbols('a.rb', 'class A < B\nend\nclass C < Mod::D\nend\n'))).toEqual(['A<B@1', 'C<D@3']);
    expect(inh(await extractSymbols('a.ts', 'class A extends B implements C {}\ninterface I extends J, K {}\nclass E extends React.Component {}\n'))).toEqual(['A<B@1', 'A<C@1', 'I<J@2', 'I<K@2', 'E<Component@3']);
    expect(inh(await extractSymbols('a.js', 'class A extends B {}\n'))).toEqual(['A<B@1']);
    expect(inh(await extractSymbols('a.go', 'package a\ntype S struct {\n\tBase\n\t*Other\n\tname string\n}\n'))).toEqual(['S<Base@3', 'S<Other@4']);
  });

  it('returns undefined for unsupported languages', async () => {
    expect(await extractSymbols('a.md', '# hi')).toBeUndefined();
  });
});

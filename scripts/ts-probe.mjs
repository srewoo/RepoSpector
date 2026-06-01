// Validation harness: runs TreeSitterParser against representative snippets for
// all 12 languages using a Node filesystem loader, and prints extracted
// symbols / imports / calls / heritage so the config can be verified empirically.
import * as TS from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { TreeSitterParser } from '../src/services/TreeSitterParser.js';

const grammarLoader = async (grammarFile) =>
    new Uint8Array(readFileSync(`./node_modules/tree-sitter-wasms/out/tree-sitter-${grammarFile}.wasm`));

const SAMPLES = {
    'a.js': `import {a} from './x.js';\nconst {createRequire} = require('module');\nexport function foo(p){ return bar(p); }\nexport const baz = (q) => bar(q);\nexport class A extends B { m(){ this.foo(); } }`,
    'a.ts': `import {a} from './x';\nexport interface I { x: number }\nexport type T = number;\nexport enum E { A, B }\nexport function foo(p: number): number { return bar(p); }\nexport class A extends B implements I, J { m(): void { this.foo(); } }`,
    'a.tsx': `import {a} from './x';\nexport function Foo(){ return <div onClick={bar}>{a}</div>; }\nexport class A extends B { m(){ this.foo(); } }`,
    'a.py': `from x import a\nimport y\nclass A(B):\n    def m(self):\n        return foo(self)\ndef foo(p):\n    return bar(p)`,
    'A.java': `package z;\nimport a.b.C;\npublic class A extends B implements I {\n  public void m() { foo(); }\n}\ninterface I {}`,
    'a.go': `package main\nimport "fmt"\nimport ( "os" )\ntype A struct { x int }\ntype I interface { M() }\nfunc Foo(p int) int { return bar(p) }\nfunc (a *A) M() { fmt.Println() }`,
    'a.rs': `use std::io;\npub struct A { x: i32 }\npub trait T { fn m(&self); }\npub enum E { X, Y }\npub fn foo(p: i32) -> i32 { bar(p) }\nimpl T for A { fn m(&self) { foo(1); } }`,
    'a.c': `#include <stdio.h>\nstruct A { int x; };\nint foo(int p) { return bar(p); }`,
    'a.cpp': `#include <vector>\nnamespace n {\nclass A : public B { public: void m(); };\n}\nint foo(int p) { return bar(p); }\nvoid A::m() { foo(1); }`,
    'a.cs': `using System;\nnamespace N {\npublic interface I {}\npublic class A : B, I { public void M() { Foo(); } }\npublic enum E { X, Y }\n}`,
    'a.rb': `require 'x'\nmodule M\nclass A < B\n  def m\n    foo\n  end\nend\nend\ndef foo\n  bar\nend`,
    'a.php': `<?php\nnamespace N;\nuse A\\B;\ninterface I {}\nclass A extends B implements I {\n  public function m() { foo(); }\n}\nfunction foo($p) { return bar($p); }`,
};

const runtimeLocator = () => './node_modules/web-tree-sitter/tree-sitter.wasm';
const parser = new TreeSitterParser({ module: TS, grammarLoader, runtimeLocator });
await parser.preloadFromFiles(Object.keys(SAMPLES).map(path => ({ path })));

for (const [path, content] of Object.entries(SAMPLES)) {
    const entry = parser.detect(path);
    console.log(`\n===== ${path} (lang=${entry?.lang}, grammar=${entry?.grammar}, ready=${parser.isReadyForPath(path)}) =====`);
    const a = parser._analyze(content, path);
    if (!a) { console.log('  <no analysis>'); continue; }
    console.log('  symbols :', a.symbols.map(s => `${s.label}:${s.name}(${s.startLine}-${s.endLine}${s.isExported ? ',exp' : ''})`).join(', '));
    console.log('  imports :', a.imports.map(i => i.source).join(', '));
    console.log('  calls   :', a.calls.map(c => `${c.name}@${c.line}`).join(', '));
    console.log('  heritage:', a.heritage.map(h => `${h.childName} ${h.type} ${h.parentName}`).join(', '));
}

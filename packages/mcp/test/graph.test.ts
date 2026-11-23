import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git.js';
import { buildGraph } from '../src/graph/build.js';
import { GraphStore } from '../src/graph/store.js';
import { git, makeRepo, write } from './helpers.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'rs-graph-')), 'graph.sqlite');
const sym = { language: 'python' as const, defs: [], calls: [{ name: 'f', line: 1 }], inherits: [] };

describe('GraphStore', () => {
  it('stores parsed symbols by blob and remembers built commits', () => {
    const store = GraphStore.open(tmpDb(), 'v1');
    expect(store.get('b1')).toBeUndefined();
    store.putMany([{ blob: 'b1', symbols: sym }]);
    expect(store.get('b1')).toEqual(sym);
    expect(store.missing(['b1', 'b2'])).toEqual(['b2']);
    expect(store.isBuilt('c1')).toBe(false);
    store.markBuilt('c1', 1);
    expect(store.isBuilt('c1')).toBe(true);
    store.close();
  });

  it('drops everything when the schema version changes', () => {
    const path = tmpDb();
    const a = GraphStore.open(path, 'v1');
    a.putMany([{ blob: 'b1', symbols: sym }]);
    a.markBuilt('c1', 1);
    a.close();
    const b = GraphStore.open(path, 'v2');
    expect(b.get('b1')).toBeUndefined();
    expect(b.isBuilt('c1')).toBe(false);
    b.close();
  });

  it('prunes blobs not seen within the retention window', () => {
    const store = GraphStore.open(tmpDb(), 'v1');
    store.putMany([{ blob: 'old', symbols: sym }], Date.now() - 40 * 86_400_000);
    store.putMany([{ blob: 'new', symbols: sym }]);
    expect(store.prune(30 * 86_400_000)).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toEqual(sym);
    store.close();
  });
});

describe('buildGraph', () => {
  it('parses every supported file at a commit, then only changed files at the next commit', async () => {
    const { root } = makeRepo();
    write(root, 'src/base.py', 'class Base:\n    pass\n');
    write(root, 'src/notes.md', '# not code\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'two');
    const repo = await GitRepo.open(root);
    const store = GraphStore.open(tmpDb(), 'v1');
    const first = await buildGraph(repo, store, git(root, 'rev-parse', 'HEAD'));
    expect(first).toMatchObject({ files: 3, parsed: 3, reused: 0 });
    expect(store.isBuilt(git(root, 'rev-parse', 'HEAD'))).toBe(true);

    write(root, 'src/base.py', 'class Base:\n    def run(self):\n        go()\n');
    git(root, 'commit', '-q', '-am', 'three');
    const second = await buildGraph(repo, store, git(root, 'rev-parse', 'HEAD'));
    expect(second).toMatchObject({ files: 3, parsed: 1, reused: 2 });
    const blob = git(root, 'rev-parse', 'HEAD:src/base.py');
    expect(store.get(blob)?.calls.map((c) => `${c.name}<${c.caller}`)).toEqual(['go<run']);
    store.close();
  });
});

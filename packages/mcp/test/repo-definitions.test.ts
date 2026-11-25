import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git.js';
import { GraphService } from '../src/graph/service.js';
import { buildPlan } from '../src/plan.js';
import { repoDefinitions } from '../src/repo-definitions.js';
import { RevisionSource } from '../src/source.js';
import { git, write } from './helpers.js';

const PRICE = `export function applyDiscount(price, pct) {
  if (pct > 100) throw new Error('pct over 100');
  return price - (price * pct) / 100;
}
`;
const CART_BASE = `export function total(items) {
  return items.reduce((s, i) => s + i.price, 0);
}
`;
const CART_CALLS = `import { applyDiscount } from './price.js';
export function total(items, pct) {
  return applyDiscount(items.reduce((s, i) => s + i.price, 0), pct);
}
`;

/** main: price.js defines applyDiscount; the change (uncommitted) makes cart.js call it. */
function repoWithHelper(): string {
  const root = mkdtempSync(join(tmpdir(), 'rs-defs-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'src/price.js', PRICE);
  write(root, 'src/cart.js', CART_BASE);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  write(root, 'src/cart.js', CART_CALLS);
  return root;
}

async function open(root: string) {
  const repo = await GitRepo.open(root);
  const graph = await GraphService.open(repo, mkdtempSync(join(tmpdir(), 'rs-defs-cache-')));
  return { repo, graph };
}

describe('definitions in the context pack', () => {
  it('adds the code of a function the uncommitted change calls, defined in another file', async () => {
    const { repo, graph } = await open(repoWithHelper());
    const plan = await buildPlan(repo, undefined, 'worktree', 'standard', { graph, waitMs: 60_000 });
    expect(plan.definitions).toMatchObject({ used: 1, indexedFiles: 2 });
    expect(plan.contextPages.join("\n")).toMatch(/kind="definitions"/);
    expect(plan.contextPages.join("\n")).toMatch(/### `applyDiscount` at src\/price\.js:1/);
    expect(plan.contextPages.join("\n")).toMatch(/pct over 100/);
    // The guidance sits outside the untrusted block, and the diff comes first.
    expect(plan.contextPages.join("\n").indexOf('kind="diff"')).toBeLessThan(plan.contextPages.join("\n").indexOf('repository content of kind "definitions"'));
    graph?.close();
  });

  it('reads definitions at a committed head, and sees a helper edited in the same commit as it is there', async () => {
    const root = repoWithHelper();
    write(root, 'src/price.js', PRICE.replace("pct over 100", 'percent too large'));
    git(root, 'commit', '-q', '-am', 'change');
    const { repo, graph } = await open(root);
    const plan = await buildPlan(repo, 'main~1', 'HEAD', 'standard', { graph, waitMs: 60_000 });
    expect(plan.contextPages.join("\n")).toMatch(/percent too large/);
    graph?.close();
  });

  it('uses the uncommitted version of a helper, not the committed one', async () => {
    const root = repoWithHelper();
    write(root, 'src/price.js', `// moved down\n\n${PRICE}`);
    const { repo, graph } = await open(root);
    const plan = await buildPlan(repo, undefined, 'worktree', 'standard', { graph, waitMs: 60_000 });
    // price.js is itself in the diff now, but applyDiscount's line is unchanged context there, so it is still shown, at its new line.
    expect(plan.contextPages.join("\n")).toMatch(/### `applyDiscount` at src\/price\.js:3/);
    graph?.close();
  });

  it('leaves out definitions the diff itself adds', async () => {
    const root = repoWithHelper();
    write(root, 'src/cart.js', `function applyDiscount(p) { return p; }\n${CART_CALLS.replace(/^import.*\n/, '')}`);
    rmSync(join(root, 'src/price.js')); // deleted in the worktree: its committed symbols must not be used
    const { repo, graph } = await open(root);
    const plan = await buildPlan(repo, undefined, 'worktree', 'standard', { graph, waitMs: 60_000 });
    expect(plan.contextPages.join("\n")).not.toMatch(/kind="definitions"/);
    graph?.close();
  });

  it('says why when there is no graph, and the pack is the diff alone', async () => {
    const root = repoWithHelper();
    const repo = await GitRepo.open(root);
    const plan = await buildPlan(repo, undefined, 'worktree', 'standard', { graph: undefined });
    expect(plan.definitions).toEqual({ used: 0, indexedFiles: 0, note: expect.stringMatching(/Node 22\.13.*get_context/) });
    expect(plan.contextPages.join("\n")).not.toMatch(/definitions/);
  });

  it('says why when the graph is not ready in time', async () => {
    const { repo, graph } = await open(repoWithHelper());
    const out = await repoDefinitions(`diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1 +1 @@\n+applyDiscount(1, 2);\n`, { repo, head: 'worktree', source: new RevisionSource(repo, 'worktree'), graph, waitMs: 0 });
    expect(out.text).toBe('');
    expect(out.summary.note).toMatch(/not ready in time/);
    graph?.close();
  });

  it('notes when the diff calls nothing', async () => {
    const { repo, graph } = await open(repoWithHelper());
    const out = await repoDefinitions('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n', { repo, head: 'worktree', source: new RevisionSource(repo, 'worktree'), graph });
    expect(out.summary).toMatchObject({ used: 0, note: expect.stringMatching(/calls nothing/) });
    graph?.close();
  });

  it('without a lookup, the plan is unchanged (no definitions field)', async () => {
    const repo = await GitRepo.open(repoWithHelper());
    const plan = await buildPlan(repo, undefined, 'worktree', 'standard');
    expect(plan.definitions).toBeUndefined();
  });
});

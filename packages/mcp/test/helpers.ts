import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const BASE_SOURCE = `export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price;
  }
  return sum;
}
`;

const CHANGED_SOURCE = `export function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price;
  }
  return sum;
}
`;

/** A repo on main with one commit, then an uncommitted off-by-one and an untracked file. */
export function makeRepo(): { root: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'rs-mcp-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'src/cart.js', BASE_SOURCE);
  write(root, 'CLAUDE.md', 'Never log card numbers.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  write(root, 'src/cart.js', CHANGED_SOURCE);
  write(root, 'src/new.js', 'export const x = 1;\nexport const y = 2;\n');
  return { root, baseSha };
}

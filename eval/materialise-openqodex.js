#!/usr/bin/env node
/**
 * Build each OpenQodex case as a real git repository for the MCP-host path:
 * base committed on `main`, the change on `change`, review range main..change.
 *
 *   node eval/materialise-openqodex.js <openqodex>/benchmark/cases <out-dir>
 *
 * Repositories get neutral names (case-01...) and neutral commit messages, and
 * <out-dir>/../oq-map.json maps each name back to its corpus id. OpenQodex's
 * case ids describe the bug, so they never reach the reviewer.
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// Optional third argument: a commit date. Repeats of one benchmark need distinct
// commit hashes, or a server that keys review sessions by base/head reuses them.
const [src, out, date = '2026-01-01T00:00:00Z'] = process.argv.slice(2);
const walk = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...a], { cwd, env, stdio: 'pipe' });
rmSync(out, { recursive: true, force: true });
const dirs = readdirSync(src).filter((d) => existsSync(join(src, d, 'case.json'))).sort();
const map = {};
dirs.forEach((d, i) => {
  const caseDir = join(src, d);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  const base = spec.base ? resolve(caseDir, spec.base) : join(caseDir, 'base');
  const change = spec.change ? resolve(caseDir, spec.change) : join(caseDir, 'change');
  const name = `case-${String(i + 1).padStart(2, '0')}`;
  const repo = join(out, name);
  mkdirSync(repo, { recursive: true });
  cpSync(base, repo, { recursive: true });
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'change');
  for (const f of walk(change)) {
    let text = readFileSync(f, 'utf8');
    for (const g of spec.generated ?? []) {
      const hex = createHash('sha256').update(`${spec.id}:${g.placeholder}`).digest('hex');
      text = text.split(g.placeholder).join(g.kind === 'stripe-live-key' ? `sk_live_${hex.slice(0, 24)}` : hex.slice(0, 32));
    }
    const to = join(repo, relative(change, f));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
  }
  const del = join(caseDir, 'delete.txt');
  if (existsSync(del)) for (const p of readFileSync(del, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)) rmSync(join(repo, p));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change');
  map[name] = `openqodex/${spec.id}`;
});
writeFileSync(join(dirname(out), 'oq-map.json'), JSON.stringify(map, null, 2));
console.log(dirs.length, 'repos');

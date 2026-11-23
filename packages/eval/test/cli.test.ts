import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-eval-'));
  const cases = join(dir, 'cases.json');
  const preds = join(dir, 'preds.json');
  writeFileSync(
    cases,
    JSON.stringify([
      {
        id: 'c1',
        repo: 'o/r',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        split: 'tuning',
        labelSource: 'synthetic',
        issues: [{ id: 'i1', file: 'a.ts', line: 3, endLine: 3, severity: 'high', description: 'bug' }],
      },
    ]),
  );
  writeFileSync(preds, JSON.stringify({ c1: [{ file: 'a.ts', startLine: 4, endLine: 4, claim: 'bug' }] }));
  return { cases, preds };
}

describe('eval CLI', () => {
  it('prints a JSON report with --json', async () => {
    const { cases, preds } = setup();
    const out: string[] = [];
    const code = await runCli(['score', '--cases', cases, '--predictions', preds, '--json'], (s) => out.push(s));
    expect(code).toBe(0);
    const report = JSON.parse(out.join('')) as { totals: { f1: number } };
    expect(report.totals.f1).toBe(1);
  });

  it('prints a readable summary by default', async () => {
    const { cases, preds } = setup();
    const out: string[] = [];
    await runCli(['score', '--cases', cases, '--predictions', preds], (s) => out.push(s));
    expect(out.join('\n')).toMatch(/F1\s+100\.0%/);
  });

  it('fails with a clear message on invalid case files', async () => {
    const { preds } = setup();
    const bad = join(mkdtempSync(join(tmpdir(), 'rs-eval-')), 'bad.json');
    writeFileSync(bad, JSON.stringify([{ id: 'c1' }]));
    const out: string[] = [];
    const code = await runCli(['score', '--cases', bad, '--predictions', preds], (s) => out.push(s));
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/case 0/);
  });

  it('prints usage for unknown commands', async () => {
    const out: string[] = [];
    expect(await runCli(['nope'], (s) => out.push(s))).toBe(2);
    expect(out.join('\n')).toMatch(/usage/i);
  });
});

describe('eval CLI binary', () => {
  it('runs when invoked through a symlink, as npm bins are', async () => {
    const { execFileSync } = await import('node:child_process');
    const { symlinkSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const link = join(mkdtempSync(join(tmpdir(), 'rs-bin-')), 'repospector-eval');
    symlinkSync(dist, link);
    const { cases, preds } = setup();
    expect(execFileSync('node', [link, 'score', '--cases', cases, '--predictions', preds], { encoding: 'utf8' })).toMatch(/F1/);
  });
});

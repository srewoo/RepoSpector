import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildContextPack, changedSymbols, parseUnifiedDiff, type ChangedSymbol, type ContextPack, type UsageHit } from '@repospector/core';

const run = promisify(execFile);
const SNIPPET_RADIUS = 3;
const MAX_LINE = 240;
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

export interface GatheredContext {
  readonly symbols: ChangedSymbol[];
  readonly pack: ContextPack;
  /** Symbols skipped because they matched too many places to be useful context. */
  readonly tooCommon: string[];
}

export interface GatherOptions {
  readonly maxHitsPerSymbol?: number;
  readonly maxChars?: number;
}

const wordRe = (name: string): RegExp => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);

/** One pass over tracked text files at the worktree's HEAD: whole-word matches of any symbol, attributed per symbol. */
async function grepSymbols(dir: string, names: readonly string[]): Promise<Map<string, { file: string; line: number }[]>> {
  const valid = names.filter((n) => NAME_RE.test(n));
  const out = new Map<string, { file: string; line: number }[]>(valid.map((n) => [n, []]));
  if (valid.length === 0) return out;
  let stdout = '';
  try {
    const patterns = valid.flatMap((n) => ['-e', n]);
    ({ stdout } = await run('git', ['-C', dir, '-c', 'core.quotePath=false', 'grep', '-n', '-w', '-F', '-I', '--no-color', ...patterns, '--', '.', ':!*.min.js', ':!*.lock', ':!*.map', ':!*.snap'], {
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (e) {
    if ((e as { code?: unknown }).code !== 1) throw e; // git grep exits 1 on no match
  }
  const res = valid.map((n) => [n, wordRe(n)] as const);
  for (const l of stdout.split('\n')) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    for (const [n, re] of res) if (re.test(m[3] ?? '')) out.get(n)?.push({ file: m[1], line: Number(m[2]) });
  }
  return out;
}

async function snippet(dir: string, file: string, line: number, cache: Map<string, string[]>): Promise<string> {
  let lines = cache.get(file);
  if (!lines) {
    lines = (await readFile(join(dir, file), 'utf8')).split('\n');
    cache.set(file, lines);
  }
  const from = Math.max(0, line - 1 - SNIPPET_RADIUS);
  return lines
    .slice(from, line + SNIPPET_RADIUS)
    .map((l, i) => `${from + i + 1}${from + i + 1 === line ? '>' : ' '} ${l.slice(0, MAX_LINE)}`)
    .join('\n');
}

/** Context pack for a PR: uses of the symbols it changes, found by grep in the PR-head worktree. */
export async function gatherContext(diff: string, dir: string, opts: GatherOptions = {}): Promise<GatheredContext> {
  const maxHits = opts.maxHitsPerSymbol ?? 150;
  const symbols = changedSymbols(diff);
  const changed = new Map(parseUnifiedDiff(diff).map((f) => [f.path, new Set(f.addedLines)]));
  const cache = new Map<string, string[]>();
  const hits: UsageHit[] = [];
  const tooCommon: string[] = [];
  const bySymbol = await grepSymbols(dir, symbols.map((s) => s.name));
  for (const s of symbols) {
    const found = (bySymbol.get(s.name) ?? []).filter((h) => !changed.get(h.file)?.has(h.line));
    if (found.length > maxHits) {
      tooCommon.push(s.name);
      continue;
    }
    for (const h of found) hits.push({ ...h, symbol: s.name, snippet: await snippet(dir, h.file, h.line, cache) });
  }
  const pack = buildContextPack(symbols, hits, changed, opts.maxChars ? { maxChars: opts.maxChars } : {});
  return { symbols, pack, tooCommon };
}

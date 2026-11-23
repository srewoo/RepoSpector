import { isTestPath, type ChangedSymbol } from './symbols.js';

/** One place in the repo (outside the diff's changed lines) that names a changed symbol. */
export interface UsageHit {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  /** The hit line with a few lines around it. Repo content: untrusted. */
  readonly snippet: string;
}

export interface ContextPack {
  /** Prompt-ready text; empty when there is nothing to show. */
  readonly text: string;
  readonly hits: readonly UsageHit[];
  /** Hits left out by the per-symbol cap or the character budget. */
  readonly omitted: number;
}

export interface ContextPackOptions {
  readonly perSymbol?: number;
  readonly maxChars?: number;
}

const rank = (h: UsageHit, changed: ReadonlyMap<string, ReadonlySet<number>>): number => (changed.has(h.file) ? 1 : 0) + (isTestPath(h.file) ? 2 : 0);

/**
 * Uses of changed symbols elsewhere in the repo, for the reviewer to check against the change.
 * Removed symbols first; per symbol, other files before the diff's own files, non-tests before tests.
 */
export function buildContextPack(
  symbols: readonly ChangedSymbol[],
  hits: readonly UsageHit[],
  changedLines: ReadonlyMap<string, ReadonlySet<number>>,
  opts: ContextPackOptions = {},
): ContextPack {
  const perSymbol = opts.perSymbol ?? 6;
  const maxChars = opts.maxChars ?? 60_000;
  const outside = hits.filter((h) => !changedLines.get(h.file)?.has(h.line));
  const ordered = [...symbols].sort((a, b) => (a.change === b.change ? 0 : a.change === 'removed' ? -1 : 1));

  let text = '';
  const shown: UsageHit[] = [];
  let omitted = 0;
  for (const s of ordered) {
    const mine = outside.filter((h) => h.symbol === s.name).sort((a, b) => rank(a, changedLines) - rank(b, changedLines));
    if (mine.length === 0) continue;
    omitted += Math.max(0, mine.length - perSymbol);
    const header = `### \`${s.name}\` (${s.change === 'removed' ? 'removed' : 'defined or changed'} in ${s.file})\n`;
    let section = '';
    for (const h of mine.slice(0, perSymbol)) {
      const block = `${h.file}:${h.line}\n\`\`\`\n${h.snippet}\n\`\`\`\n`;
      if (text.length + header.length + section.length + block.length > maxChars) {
        omitted++;
        continue;
      }
      section += block;
      shown.push(h);
    }
    if (section) text += header + section;
  }
  return { text, hits: shown, omitted };
}

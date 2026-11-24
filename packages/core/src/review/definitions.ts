import type { FileSymbols } from '../graph/extract.js';
import { isTestPath } from '../symbols.js';
import { redactSecrets } from '../untrusted.js';

/** Same limits as the measured eval pass (eval/src/definitions.ts): a definition's first lines, capped. */
export const DEFINITION_BODY_LINES = 20;
export const DEFINITION_MAX_LINE = 240;
export const DEFINITIONS_MAX_CHARS = 60_000;
/** Names defined in more places than this are left out rather than guessed. */
export const MAX_DEFS_PER_NAME = 3;

export interface DefinitionSite {
  readonly name: string;
  readonly file: string;
  /** The line of the name (where the eval pass started its excerpt). */
  readonly line: number;
}

export interface LocatedDefinitions {
  readonly found: DefinitionSite[];
  /** Defined in more than MAX_DEFS_PER_NAME places. */
  readonly ambiguous: string[];
  /** Not defined anywhere in the indexed files (library, builtin, or an unsupported language). */
  readonly missing: string[];
}

/**
 * Where the names the diff calls are defined, from the repository index at the PR head. Test files
 * and definitions the diff itself adds (the reviewer already sees them) are left out. Order follows
 * `names` (most used first), then path.
 */
export function locateDefinitions(files: ReadonlyMap<string, FileSymbols>, names: readonly string[], addedLines: ReadonlyMap<string, ReadonlySet<number>>): LocatedDefinitions {
  const byName = new Map<string, DefinitionSite[]>(names.map((n) => [n, []]));
  for (const [file, s] of files) {
    if (isTestPath(file)) continue;
    for (const d of s.defs) {
      // JS/TS private members are indexed as `#name`; calls (`this.#name(`) are read as `name`.
      const name = d.name.replace(/^#/, '');
      const list = byName.get(name);
      if (list && !addedLines.get(file)?.has(d.nameLine)) list.push({ name, file, line: d.nameLine });
    }
  }
  const found: DefinitionSite[] = [];
  const ambiguous: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const defs = (byName.get(n) ?? []).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    if (defs.length === 0) missing.push(n);
    else if (defs.length > MAX_DEFS_PER_NAME) ambiguous.push(n);
    else found.push(...defs);
  }
  return { found, ambiguous, missing };
}

/**
 * The <definitions> text, in the eval pass's format: one block per definition with its first
 * DEFINITION_BODY_LINES lines. `contentOf` returns a file's text at the PR head (undefined = could
 * not be read; that definition is skipped). Secrets are masked. Blocks that would pass maxChars are left out.
 */
export function definitionsText(sites: readonly DefinitionSite[], contentOf: (file: string) => string | undefined, maxChars = DEFINITIONS_MAX_CHARS): { text: string; used: DefinitionSite[] } {
  let text = '';
  const used: DefinitionSite[] = [];
  const lines = new Map<string, string[] | undefined>();
  for (const d of sites) {
    if (!lines.has(d.file)) lines.set(d.file, contentOf(d.file)?.split('\n'));
    const all = lines.get(d.file);
    if (!all) continue;
    const body = all.slice(d.line - 1, d.line - 1 + DEFINITION_BODY_LINES).map((l) => l.slice(0, DEFINITION_MAX_LINE));
    const block = redactSecrets(`### \`${d.name}\` at ${d.file}:${d.line}\n\`\`\`\n${body.join('\n')}\n\`\`\`\n`);
    if (text.length + block.length > maxChars) continue;
    text += block;
    used.push(d);
  }
  return { text, used };
}

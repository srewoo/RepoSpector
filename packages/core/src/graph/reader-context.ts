import { isSafeRepoPath } from '../finding.js';
import { isSkippablePath } from '../risk.js';
import { isSecretPath } from '../untrusted.js';
import { languageFor } from './languages.js';
import { MAX_PARSE_BYTES, type DefKind, type FileSymbols } from './extract.js';

/** Files a graph covers: supported language, safe path, not secret or generated, small enough to parse. */
export function isIndexable(path: string, size: number): boolean {
  return languageFor(path) !== undefined && size <= MAX_PARSE_BYTES && isSafeRepoPath(path) && !isSecretPath(path) && !isSkippablePath(path);
}

export interface Place {
  readonly file: string;
  readonly line: number;
}

/**
 * What the reader of a finding may want to see: the function or class the finding's line is in,
 * who calls it, other definitions with the same name (implementations, overrides), and subclasses.
 * Matching is by name, not by type, so a list can include unrelated symbols that share the name.
 */
export interface FindingContext {
  readonly symbol: { readonly name: string; readonly kind: DefKind; readonly file: string; readonly startLine: number; readonly endLine: number };
  readonly callers: readonly (Place & { readonly caller?: string | undefined })[];
  readonly callerCount: number;
  readonly sameName: readonly (Place & { readonly kind: DefKind })[];
  readonly subtypes: readonly (Place & { readonly name: string })[];
}

export const MAX_LISTED = { callers: 20, sameName: 10, subtypes: 10 } as const;

/** Context per finding id; findings at top level (no enclosing definition) get none. */
export function readerContext(files: ReadonlyMap<string, FileSymbols>, findings: readonly { readonly id: string; readonly file: string; readonly line: number }[]): Record<string, FindingContext> {
  const out: Record<string, FindingContext> = {};
  for (const f of findings) {
    const own = files.get(f.file);
    // Innermost definition around the line: the smallest range that contains it.
    const symbol = own?.defs.filter((d) => d.startLine <= f.line && f.line <= d.endLine).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    if (!symbol) continue;
    const callers: (Place & { caller?: string })[] = [];
    const sameName: (Place & { kind: DefKind })[] = [];
    const subtypes: (Place & { name: string })[] = [];
    for (const [file, s] of files) {
      for (const c of s.calls) {
        // A call inside the symbol itself (recursion) is not a caller.
        if (c.name !== symbol.name || (file === f.file && c.line >= symbol.startLine && c.line <= symbol.endLine)) continue;
        callers.push({ file, line: c.line, ...(c.caller ? { caller: c.caller } : {}) });
      }
      for (const d of s.defs) if (d.name === symbol.name && !(file === f.file && d.startLine === symbol.startLine)) sameName.push({ file, line: d.nameLine, kind: d.kind });
      if (symbol.kind === 'class' || symbol.kind === 'type') for (const i of s.inherits) if (i.base === symbol.name) subtypes.push({ file, line: i.line, name: i.child });
    }
    const byPlace = (a: Place, b: Place) => a.file.localeCompare(b.file) || a.line - b.line;
    out[f.id] = {
      symbol: { name: symbol.name, kind: symbol.kind, file: f.file, startLine: symbol.startLine, endLine: symbol.endLine },
      callers: callers.sort(byPlace).slice(0, MAX_LISTED.callers),
      callerCount: callers.length,
      sameName: sameName.sort(byPlace).slice(0, MAX_LISTED.sameName),
      subtypes: subtypes.sort(byPlace).slice(0, MAX_LISTED.subtypes),
    };
  }
  return out;
}

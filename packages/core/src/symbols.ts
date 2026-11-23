import { parseUnifiedDiff, splitDiffByFile } from './diff.js';

/** A symbol whose definition the diff adds, changes or removes. Lexical, language-agnostic; no parser. */
export interface ChangedSymbol {
  readonly name: string;
  /** removed: defined only on removed lines, so remaining uses may break. defined: added or changed. */
  readonly change: 'removed' | 'defined';
  readonly file: string;
}

const KEYWORD_DEF = /\b(?:def|class|func|function|interface|type|struct|enum|module|trait)\s+(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_]\w*)/;
const JS_CONST_FN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const MODIFIER_METHOD = /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default|override|async)\s+)+(?:[\w<>[\],.?]+\s+)*?([A-Za-z_]\w*)\s*\(/;
const BARE_METHOD = /^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;
/** A type member: optional (`name?:`) or ending in `;`. Object-literal keys end in `,` or `{` and do not match. */
const TS_FIELD = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(?:\?\s*:\s*[^,{]+?;?|\s*:\s*[^,{]+?;)\s*$/;

export const NOT_NAMES: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'else', 'do', 'try', 'with', 'super', 'this']);
export const GENERIC: ReadonlySet<string> = new Set([
  'init', '__init__', 'main', 'run', 'get', 'set', 'render', 'constructor', 'setup', 'call', 'handle', 'apply', 'execute',
  'process', 'update', 'create', 'delete', 'toString', 'equals', 'hashCode', 'test', 'Props', 'State', 'value', 'name', 'type', 'data', 'id',
]);

/** Test, spec and fixture paths: their own definitions are not context worth chasing. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|fixtures?)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_(test|spec)\.(go|py|rb)$/.test(path) ||
    /Tests?\.java$/.test(path)
  );
}

/** The name a line defines (function, method, class, type, TS field), or null. Generic names count as none. */
export function definitionName(line: string, path: string): string | null {
  const name = definedNameAny(line, path);
  return name && name.length >= 3 && !GENERIC.has(name) ? name : null;
}

/** Like definitionName, but keeps generic names: for an explicit lookup of one symbol. */
export function definedNameAny(line: string, path: string): string | null {
  const m = line.match(KEYWORD_DEF) ?? line.match(JS_CONST_FN) ?? line.match(MODIFIER_METHOD) ?? line.match(BARE_METHOD) ?? (/\.tsx?$/.test(path) ? line.match(TS_FIELD) : null);
  const name = m?.[1];
  return name && !NOT_NAMES.has(name) ? name : null;
}

/** Symbols whose definitions the diff touches: removed first, then defined, each in diff order. */
export function changedSymbols(diffText: string, limit = 20): ChangedSymbol[] {
  const added = new Map<string, string>();
  const removed = new Map<string, string>();
  for (const chunk of splitDiffByFile(diffText)) {
    const [file] = parseUnifiedDiff(chunk);
    if (!file || file.binary) continue;
    const path = file.status === 'deleted' ? file.oldPath : file.path;
    if (isTestPath(path)) continue;
    let inHunk = false;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('@@')) inHunk = true;
      if (!inHunk || line.startsWith('+++') || line.startsWith('---')) continue;
      const tag = line[0];
      if (tag !== '+' && tag !== '-') continue;
      const name = definitionName(line.slice(1), path);
      if (!name) continue;
      const target = tag === '+' ? added : removed;
      if (!target.has(name)) target.set(name, path);
    }
  }
  const out: ChangedSymbol[] = [];
  for (const [name, file] of removed) if (!added.has(name)) out.push({ name, change: 'removed', file });
  for (const [name, file] of added) out.push({ name, change: 'defined', file });
  for (const [name, file] of removed) if (added.has(name) && !out.some((s) => s.name === name)) out.push({ name, change: 'defined', file });
  return out.slice(0, limit);
}

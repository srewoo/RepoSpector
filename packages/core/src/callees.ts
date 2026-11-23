import { parseUnifiedDiff, splitDiffByFile } from './diff.js';
import { definitionName, GENERIC, isTestPath, NOT_NAMES } from './symbols.js';

/** Library and language builtins: their definitions are not in the repo, or are too common to help. */
const BUILTINS = new Set([
  'print', 'range', 'str', 'int', 'dict', 'list', 'tuple', 'isinstance', 'getattr', 'setattr', 'hasattr', 'map', 'filter',
  'push', 'pop', 'log', 'error', 'warn', 'info', 'debug', 'then', 'catch', 'resolve', 'reject', 'require', 'import', 'append',
  'extend', 'join', 'split', 'format', 'keys', 'values', 'items', 'toString', 'parseInt', 'parseFloat', 'String', 'Number',
  'Boolean', 'Array', 'Object', 'JSON', 'Promise', 'Error', 'assert', 'expect', 'describe', 'make', 'Errorf', 'Sprintf',
  'Printf', 'Println', 'includes', 'indexOf', 'slice', 'splice', 'forEach', 'reduce', 'find', 'some', 'every', 'replace',
  'trim', 'startsWith', 'endsWith', 'sort', 'concat', 'bind', 'toLowerCase', 'toUpperCase', 'length', 'size', 'stream',
  'collect', 'remove', 'contains', 'isEmpty', 'asList', 'valueOf', 'Date', 'Math', 'Set', 'Map', 'useState', 'useEffect',
  'useMemo', 'useCallback', 'useRef', 'useContext', 'self', 'cls', 'lambda', 'typeof', 'instanceof', 'await', 'async',
  'sizeof', 'panic', 'recover', 'close', 'copy', 'printf', 'puts', 'raise', 'yield', 'elif', 'unless', 'until', 'sorted',
  'enumerate', 'zip', 'next', 'iter', 'open', 'round', 'abs', 'min', 'max', 'sum', 'any', 'all', 'float', 'bool', 'bytes',
]);

const CALL = /(?<![\w$.])(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const METHOD_CALL = /\.([A-Za-z_$][\w$]*)\s*\(/g;
const EXTENDS = /\b(?:extends|implements)\s+([A-Za-z_$][\w$.]*(?:\s*,\s*[A-Za-z_$][\w$.]*)*)/g;
const PY_BASES = /^\s*class\s+\w+\s*\(([^)]*)\)/;
const JSX = /<([A-Z][\w$]*)[\s/>]/g;

const usable = (n: string, defined: ReadonlySet<string>): boolean =>
  n.length >= 4 && !NOT_NAMES.has(n) && !GENERIC.has(n) && !BUILTINS.has(n) && !defined.has(n);

function namesOnLine(line: string): string[] {
  const out: string[] = [];
  for (const re of [CALL, METHOD_CALL, JSX]) for (const m of line.matchAll(re)) if (m[1]) out.push(m[1]);
  for (const m of line.matchAll(EXTENDS)) for (const b of (m[1] ?? '').split(',')) out.push(b.trim().split('.').pop() ?? '');
  const py = line.match(PY_BASES);
  if (py?.[1]) for (const b of py[1].split(',')) out.push(b.trim().split('.').pop()?.split('[')[0] ?? '');
  return out;
}

/**
 * Names the diff's added lines call, construct, extend or render, most used first. Names the diff
 * itself defines are left out (the reviewer already sees them), as are test files.
 */
export function calledNames(diffText: string, limit = 25): string[] {
  const defined = new Set<string>();
  const counts = new Map<string, number>();
  for (const chunk of splitDiffByFile(diffText)) {
    const [file] = parseUnifiedDiff(chunk);
    if (!file || file.binary || file.status === 'deleted' || isTestPath(file.path)) continue;
    let inHunk = false;
    for (const raw of chunk.split('\n')) {
      if (raw.startsWith('@@')) inHunk = true;
      if (!inHunk || raw.startsWith('+++') || raw.startsWith('---')) continue;
      if (raw[0] !== '+' && raw[0] !== '-') continue;
      const line = raw.slice(1);
      const def = definitionName(line, file.path);
      if (def) defined.add(def);
      if (raw[0] === '+') for (const n of namesOnLine(line)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([n]) => usable(n, defined))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n]) => n);
}

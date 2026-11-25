import { parseUnifiedDiff } from './diff.js';
import { isSafeRepoPath } from './finding.js';
import { fingerprint } from './fingerprint.js';
import { redactSecrets } from './untrusted.js';

/**
 * Results of linters, type checkers, scanners and tests: from the pull request's CI (check runs,
 * annotations, pipeline jobs) or from commands the user approved locally. These are tool output,
 * not model findings; they are shown and can be posted, but never fed to the review model.
 */
export type DiagnosticLevel = 'error' | 'warning' | 'notice';

export interface Diagnostic {
  /** The check or command that reported it, e.g. "eslint" or "CI: lint". */
  readonly source: string;
  readonly file: string;
  readonly line: number;
  readonly level: DiagnosticLevel;
  readonly message: string;
}

export type CheckStatus = 'passed' | 'failed' | 'pending' | 'skipped';

export interface CiCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly url?: string | undefined;
  /** Short reason for a failure when there are no line diagnostics. */
  readonly summary?: string | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

export const MAX_DIAGNOSTICS = 200;
const MAX_MESSAGE = 500;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Level from a rule code such as W291 (pycodestyle/ruff): W → warning, C/N/D → notice, others → error. */
const codeLevel = (message: string | undefined): DiagnosticLevel => {
  const c = /^([A-Z])\d{2,4}\b/.exec(message ?? '')?.[1];
  return c === 'W' ? 'warning' : c === 'C' || c === 'N' || c === 'D' ? 'notice' : 'error';
};
const LEVEL = (s: string | undefined): DiagnosticLevel => (/^(warn|warning|w)$/i.test(s ?? '') ? 'warning' : /^(note|notice|info|hint|i|c|convention)$/i.test(s ?? '') ? 'notice' : 'error');

/** A tool path as a repo-relative path, or undefined if it points outside the repository. */
export function toRepoPath(path: string, root = ''): string | undefined {
  let p = path.trim().replace(/\\/g, '/');
  if (root && p.startsWith(`${root.replace(/\/$/, '')}/`)) p = p.slice(root.replace(/\/$/, '').length + 1);
  p = p.replace(/^\.\//, '');
  return isSafeRepoPath(p) ? p : undefined;
}

/**
 * Line diagnostics in common tool output formats: `path:line[:col]: [level:] message` (gcc, go vet,
 * ruff, flake8, eslint unix/compact, rubocop, pytest), `path(line,col): error TS…: message` (tsc),
 * and eslint's stylish blocks (a path line, then `  line:col  level  message`).
 */
export function parseToolOutput(source: string, output: string, root = ''): Diagnostic[] {
  const out: Diagnostic[] = [];
  let stylishFile: string | undefined;
  for (const raw of output.replace(ANSI, '').split('\n')) {
    if (out.length >= MAX_DIAGNOSTICS) break;
    const line = raw.trimEnd();
    const push = (file: string | undefined, n: string | undefined, level: DiagnosticLevel, message: string | undefined): void => {
      const num = Number(n);
      if (!file || !Number.isInteger(num) || num < 1 || !message?.trim()) return;
      out.push({ source, file, line: num, level, message: redactSecrets(message.trim()).slice(0, MAX_MESSAGE) });
    };
    let m = /^(.+?)\((\d+),\d+\):\s*(error|warning)\s+(.*)$/.exec(line);
    if (m) {
      push(toRepoPath(m[1] ?? '', root), m[2], LEVEL(m[3]), m[4]);
      continue;
    }
    m = /^([^\s:][^:]*?):(\d+)(?::\d+)?:\s*(?:\[?(error|warning|warn|note|info|[EWCFI])\]?[:\s]\s*)?(.+)$/i.exec(line);
    if (m && !/^\d+$/.test(m[1] ?? '') && !/^https?$/i.test(m[1] ?? '')) {
      const file = toRepoPath(m[1] ?? '', root);
      if (file) {
        push(file, m[2], m[3] ? LEVEL(m[3]) : codeLevel(m[4]), m[4]);
        stylishFile = undefined;
        continue;
      }
    }
    m = /^\s+(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/.exec(line);
    if (m && stylishFile) {
      push(stylishFile, m[1], LEVEL(m[2]), m[3]);
      continue;
    }
    const asFile = /^\S/.test(line) ? toRepoPath(line, root) : undefined;
    stylishFile = asFile && !line.includes(' ') ? asFile : line.trim() === '' ? stylishFile : undefined;
  }
  return out;
}

/** Diagnostics on lines the diff adds or changes (what the pull request introduced, not context lines). */
export function onChangedLines(diagnostics: readonly Diagnostic[], diffText: string): Diagnostic[] {
  const added = new Map<string, Set<number>>();
  for (const f of parseUnifiedDiff(diffText)) added.set(f.path, new Set(f.addedLines));
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.file}:${d.line}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return added.get(d.file)?.has(d.line) ?? false;
  });
}

export function diagnosticFingerprint(d: Diagnostic): string {
  return fingerprint({ file: d.file, category: 'ci', claim: `${d.source}: ${d.message}` });
}

/** One line per check for a summary, failures first. */
export function checksLine(checks: readonly CiCheck[]): string {
  if (checks.length === 0) return 'No CI results found for this commit.';
  const by = (s: CheckStatus) => checks.filter((c) => c.status === s).map((c) => c.name);
  const failed = by('failed');
  const pending = by('pending');
  const parts = [`${checks.length - failed.length - pending.length} passed or skipped`];
  if (failed.length) parts.unshift(`${failed.length} failing (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''})`);
  if (pending.length) parts.push(`${pending.length} still running`);
  return `CI: ${parts.join(', ')}.`;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface DiffFile {
  readonly path: string;
  readonly oldPath: string;
  readonly status: FileStatus;
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
  /** Line numbers in the new file that were added or changed. */
  readonly addedLines: readonly number[];
  readonly removedCount: number;
}

interface MutableFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  addedLines: number[];
  removedCount: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip git's C-style quoting and the a/ or b/ prefix. Returns null for /dev/null. */
function cleanPath(raw: string, stripPrefix = true): string | null {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  if (p === '/dev/null') return null;
  return stripPrefix ? p.replace(/^[ab]\//, '') : p;
}

function headerPaths(line: string): [string, string] {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^"(.*)" "(.*)"$/);
  if (quoted) return [cleanPath(`"${quoted[1]}"`) ?? '', cleanPath(`"${quoted[2]}"`) ?? ''];
  const mid = rest.indexOf(' b/');
  if (mid === -1) return [cleanPath(rest) ?? '', cleanPath(rest) ?? ''];
  return [cleanPath(rest.slice(0, mid)) ?? '', cleanPath(rest.slice(mid + 1)) ?? ''];
}

/** Raw diff text per file, in the same order parseUnifiedDiff returns files. */
export function splitDiffByFile(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ') || parts.length === 0) parts.push(line);
    else parts[parts.length - 1] += line;
  }
  return parts.filter((p) => p.startsWith('diff --git '));
}

/** Parse `git diff` output. Tolerant of extended headers; ignores content outside hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: MutableFile[] = [];
  let current: MutableFile | null = null;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [oldPath, path] = headerPaths(line);
      current = { path, oldPath, status: 'modified', binary: false, hunks: [], addedLines: [], removedCount: 0 };
      files.push(current);
      oldRemaining = newRemaining = 0;
      continue;
    }
    if (!current) continue;

    if (oldRemaining > 0 || newRemaining > 0) {
      const tag = line[0];
      if (tag === '+') {
        current.addedLines.push(newLine++);
        newRemaining--;
        continue;
      }
      if (tag === '-') {
        current.removedCount++;
        oldRemaining--;
        continue;
      }
      if (tag === ' ' || line === '') {
        newLine++;
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (tag === '\\') continue;
    }

    const hunk = line.match(HUNK_RE);
    if (hunk) {
      const h: Hunk = {
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
      };
      current.hunks.push(h);
      newLine = h.newStart;
      oldRemaining = h.oldLines;
      newRemaining = h.newLines;
    } else if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = cleanPath(line.slice('rename from '.length), false) ?? current.oldPath;
    } else if (line.startsWith('rename to ')) current.path = cleanPath(line.slice('rename to '.length), false) ?? current.path;
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
    else if (line.startsWith('--- ')) {
      if (cleanPath(line.slice(4)) === null) current.status = 'added';
    } else if (line.startsWith('+++ ')) {
      const p = cleanPath(line.slice(4));
      if (p === null) current.status = 'deleted';
      else current.path = p;
    }
  }
  return files;
}

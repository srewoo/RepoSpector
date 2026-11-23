import type { DiffFile } from './diff.js';
import { isSecretPath } from './untrusted.js';

export type RiskTier = 'skip' | 'trivial' | 'standard' | 'high';

export interface SkippedFile {
  readonly path: string;
  readonly reason: 'lockfile or generated' | 'binary' | 'deleted' | 'possible secrets' | 'unreadable (binary or over 2 MB)';
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly reasons: string[];
  readonly reviewable: DiffFile[];
  readonly skipped: SkippedFile[];
  readonly changedLines: number;
}

const SKIP_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|Pipfile\.lock)$/,
  /(^|\/)(dist|build|vendor|node_modules)\//,
  /\.min\.(js|css)$/,
  /\.(pb\.go|pb\.ts|_pb2\.py|generated\.\w+|g\.dart)$/,
  /(^|\/)__snapshots__\//,
];

const SENSITIVE = /(^|[\/_.-])(auth\w*|login|session|password|passwd|token|secret|crypto|oauth|payment|billing|migrations?|permission\w*|acl|security|sql)([\/_.-]|$)/i;

const TRIVIAL_MAX_LINES = 20;
const HIGH_MIN_LINES = 500;

export function isSkippablePath(path: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(path));
}

/** Decide how much review a change gets. Size and sensitive paths only; caller impact comes with the graph. */
export function assessRisk(files: readonly DiffFile[]): RiskAssessment {
  const reviewable: DiffFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const f of files) {
    if (f.binary) skipped.push({ path: f.path, reason: 'binary' });
    else if (f.status === 'deleted') skipped.push({ path: f.path, reason: 'deleted' });
    else if (isSecretPath(f.path)) skipped.push({ path: f.path, reason: 'possible secrets' });
    else if (isSkippablePath(f.path)) skipped.push({ path: f.path, reason: 'lockfile or generated' });
    else reviewable.push(f);
  }

  const changedLines = reviewable.reduce((n, f) => n + f.addedLines.length + f.removedCount, 0);
  if (reviewable.length === 0) {
    return { tier: 'skip', reasons: ['no reviewable source changes'], reviewable, skipped, changedLines };
  }

  const sensitive = reviewable.filter((f) => SENSITIVE.test(f.path)).map((f) => f.path);
  const reasons: string[] = [`${changedLines} changed lines in ${reviewable.length} files`];
  if (sensitive.length > 0) reasons.push(`touches sensitive paths: ${sensitive.join(', ')}`);

  let tier: RiskTier = 'standard';
  if (sensitive.length > 0 || changedLines >= HIGH_MIN_LINES) tier = 'high';
  else if (changedLines <= TRIVIAL_MAX_LINES) tier = 'trivial';
  return { tier, reasons, reviewable, skipped, changedLines };
}

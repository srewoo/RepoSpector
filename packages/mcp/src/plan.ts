import {
  DEFINITIONS_ADDENDUM,
  assessRisk,
  changedSymbols,
  isSecretPath,
  isSkippablePath,
  parseUnifiedDiff,
  redactSecrets,
  selectSpecialists,
  splitDiffByFile,
  wrapUntrusted,
  type Category,
  type ChangedSymbol,
  type Depth,
  type DiffFile,
  type RiskTier,
  type SkippedFile,
} from '@repospector/core';
import type { GitRepo, Head } from './git.js';
import { repoDefinitions, type DefinitionsDeps, type PlanDefinitions } from './repo-definitions.js';
import { RevisionSource } from './source.js';

/** Upper bound on diff text handed to agents; files past it are listed as not reviewed. */
export const MAX_PACK_CHARS = 150_000;
const MAX_RULES_CHARS = 20_000;
const MAX_UNTRACKED = 300;
const RULE_FILES = ['.RepoSpector/rules.md', 'CLAUDE.md', 'AGENTS.md'];
const UNREADABLE = 'unreadable (binary or over 2 MB)';

export interface PlannedFile {
  readonly path: string;
  readonly status: DiffFile['status'];
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface ReviewPlan {
  readonly baseSha: string;
  readonly head: Head;
  readonly tier: RiskTier;
  readonly reasons: string[];
  readonly specialists: Category[];
  /** Files actually in the context pack and readable. Nothing else is called reviewed. */
  readonly files: PlannedFile[];
  readonly skipped: SkippedFile[];
  /** Files left out of the context pack because of size limits. */
  readonly notIncluded: string[];
  readonly contextPack: string;
  /** Functions, classes and fields the reviewed diff defines, changes or removes: lookup targets for get_context. */
  readonly changedSymbols: ChangedSymbol[];
  /** Definitions of what the diff calls, put in the context pack (absent when not looked up). */
  readonly definitions?: PlanDefinitions;
  readonly source: RevisionSource;
}

function untrackedDiff(path: string, lines: readonly string[]): string {
  const body = lines.map((l) => `+${l}`).join('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

async function readRules(source: RevisionSource): Promise<string> {
  await source.preload(RULE_FILES);
  return RULE_FILES.flatMap((p) => {
    const lines = source.lines(p);
    return lines ? [`--- ${p} ---\n${lines.join('\n')}`] : [];
  })
    .join('\n\n')
    .slice(0, MAX_RULES_CHARS);
}

/**
 * Untracked files become added-file diffs. Lockfile, generated and secret paths are skipped
 * without being read; unreadable ones are reported; past the cap they are listed as not included.
 */
async function collectUntracked(repo: GitRepo, source: RevisionSource, skipped: SkippedFile[], notIncluded: string[]): Promise<string> {
  const candidates: string[] = [];
  for (const p of await repo.untrackedFiles()) {
    if (isSecretPath(p)) skipped.push({ path: p, reason: 'possible secrets' });
    else if (isSkippablePath(p)) skipped.push({ path: p, reason: 'lockfile or generated' });
    else if (candidates.length >= MAX_UNTRACKED) notIncluded.push(p);
    else candidates.push(p);
  }
  await source.preload(candidates);
  let diff = '';
  for (const p of candidates) {
    const lines = source.lines(p);
    if (!lines) skipped.push({ path: p, reason: UNREADABLE });
    else if (lines.length > 0) diff += untrackedDiff(p, lines);
  }
  return diff;
}

/** Pass `lookup` to add the definitions of what the diff calls to the context pack. */
export async function buildPlan(repo: GitRepo, base: string | undefined, head: Head, depth: Depth, lookup?: Pick<DefinitionsDeps, 'graph' | 'waitMs'>): Promise<ReviewPlan> {
  const headSha = head === 'worktree' ? head : await repo.resolveCommit(head);
  const baseSha = base ? await repo.resolveCommit(base) : await repo.defaultBase(headSha === 'worktree' ? 'HEAD' : headSha);
  const source = new RevisionSource(repo, headSha);
  const skipped: SkippedFile[] = [];
  const notIncluded: string[] = [];

  let rawDiff = await repo.diff(baseSha, headSha);
  if (headSha === 'worktree') rawDiff += await collectUntracked(repo, source, skipped, notIncluded);

  const parsed = parseUnifiedDiff(rawDiff);
  const chunks = splitDiffByFile(rawDiff);
  const risk = assessRisk(parsed);
  skipped.push(...risk.skipped);
  await source.preload(risk.reviewable.map((f) => f.path));

  const included: { file: DiffFile; chunk: string }[] = [];
  let size = 0;
  for (const file of risk.reviewable) {
    const chunk = chunks[parsed.indexOf(file)] ?? '';
    if (source.lineCount(file.path) === undefined) skipped.push({ path: file.path, reason: UNREADABLE });
    else if (size + chunk.length > MAX_PACK_CHARS) notIncluded.push(file.path);
    else {
      included.push({ file, chunk });
      size += chunk.length;
    }
  }

  const rules = await readRules(source);
  const reviewed = included.map((i) => i.chunk).join('');
  const defs = lookup && included.length ? await repoDefinitions(reviewed, { repo, head: headSha, source, ...lookup }) : undefined;
  const contextPack = [
    wrapUntrusted('diff', redactSecrets(reviewed)),
    defs?.text ? `${DEFINITIONS_ADDENDUM.replace('<definitions>', 'The repository content of kind "definitions"')}\n${wrapUntrusted('definitions', defs.text)}` : '',
    rules ? wrapUntrusted('team-rules', redactSecrets(rules)) : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Tier from what is actually reviewed, so unreadable or excluded files do not inflate it.
  const tier = included.length === 0 ? 'skip' : risk.tier;
  return {
    baseSha,
    head: headSha,
    tier,
    reasons: risk.reasons,
    specialists: selectSpecialists({ tier, depth, hasRules: rules.length > 0, hasIssue: false }),
    files: included.map(({ file: f }) => ({
      path: f.path,
      status: f.status,
      addedLines: f.addedLines.length,
      removedLines: f.removedCount,
    })),
    skipped,
    notIncluded,
    contextPack,
    changedSymbols: changedSymbols(reviewed),
    ...(defs ? { definitions: defs.summary } : {}),
    source,
  };
}

import {
  DEFINITIONS_ADDENDUM,
  assessRisk,
  changedSymbols,
  isSecretPath,
  isSkippablePath,
  parseUnifiedDiff,
  extractIssueRefs,
  issueRefLabel,
  redactSecrets,
  restrictDiff,
  RULE_FILES as HOST_RULE_FILES,
  selectSpecialists,
  splitDiffByFile,
  type Category,
  type ChangedSymbol,
  type Depth,
  type DiffFile,
  type RiskTier,
  type SkippedFile,
} from '@repospector/core';
import type { GitRepo, Head } from './git.js';
import { buildPages } from './pack.js';
import { repoDefinitions, type DefinitionsDeps, type PlanDefinitions } from './repo-definitions.js';
import type { ReviewSource } from './review-source.js';
import { RevisionSource } from './source.js';

/** Upper bound on diff text handed to agents; files past it are listed as not reviewed. */
export const MAX_PACK_CHARS = 150_000;
const MAX_RULES_CHARS = 20_000;
const MAX_UNTRACKED = 300;
const RULE_FILES: readonly string[] = HOST_RULE_FILES;
export const UNREADABLE = 'unreadable (binary or over 2 MB)';

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
  /** The context pack in pages that fit an agent's tool-result limit (diff, then definitions, then rules). */
  readonly contextPages: string[];
  /** Functions, classes and fields the reviewed diff defines, changes or removes: lookup targets for get_context. */
  readonly changedSymbols: ChangedSymbol[];
  /** Definitions of what the diff calls, put in the context pack (absent when not looked up). */
  readonly definitions?: PlanDefinitions;
  readonly source: ReviewSource;
  /** Set for a pull/merge request fetched through the agent's GitHub/GitLab MCP tools. */
  readonly remote?: { readonly url: string; readonly diff: string } | undefined;
  /** The diff of the files in the pack (server-side only: check results are matched against it). */
  readonly reviewedDiff: string;
  /** Re-review: only files changed since this commit were reviewed. */
  readonly incremental?: { readonly since: string; readonly files: string[] } | undefined;
  /** Issue and ticket references (#12, owner/repo#12, ABC-123) in the title, description, branch or commits: fetch them and call provide_issues. */
  readonly ticketRefs: string[];
}

function untrackedDiff(path: string, lines: readonly string[]): string {
  const body = lines.map((l) => `+${l}`).join('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

export async function readRules(source: ReviewSource): Promise<string> {
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

export interface PlanInput {
  readonly baseSha: string;
  readonly head: Head;
  readonly rawDiff: string;
  readonly source: ReviewSource;
  readonly depth: Depth;
  readonly skipped?: SkippedFile[];
  readonly notIncluded?: string[];
  /** Definitions of what the reviewed diff calls, from the rest of the repository. */
  readonly definitions?: (reviewedDiff: string) => Promise<{ text: string; summary: PlanDefinitions } | undefined>;
  readonly remote?: ReviewPlan['remote'];
  /** Review only these files (changed since an earlier reviewed commit). */
  readonly onlyFiles?: { readonly since: string; readonly files: ReadonlySet<string> } | undefined;
  /** Title, description, branch name or commit subjects, searched for issue references. */
  readonly refText?: string | undefined;
  /** Host for issue URLs in refText (github.com, gitlab.example.com). */
  readonly refHost?: string | undefined;
}

const DEFINITIONS_PREFACE = DEFINITIONS_ADDENDUM.replace('<definitions>', 'The repository content of kind "definitions"');

/** Shared by local and remote reviews: risk, the files that fit, the paged context pack, specialists. */
export async function assemblePlan(input: PlanInput): Promise<ReviewPlan> {
  const skipped = [...(input.skipped ?? [])];
  const notIncluded = [...(input.notIncluded ?? [])];
  const rawDiff = input.onlyFiles ? restrictDiff(input.rawDiff, input.onlyFiles.files) : input.rawDiff;
  const parsed = parseUnifiedDiff(rawDiff);
  const chunks = splitDiffByFile(rawDiff);
  const risk = assessRisk(parsed);
  skipped.push(...risk.skipped);
  await input.source.preload(risk.reviewable.map((f) => f.path));

  const included: { file: DiffFile; chunk: string }[] = [];
  let size = 0;
  for (const file of risk.reviewable) {
    const chunk = chunks[parsed.indexOf(file)] ?? '';
    if (input.source.lineCount(file.path) === undefined) skipped.push({ path: file.path, reason: UNREADABLE });
    else if (size + chunk.length > MAX_PACK_CHARS) notIncluded.push(file.path);
    else {
      included.push({ file, chunk });
      size += chunk.length;
    }
  }

  const rules = await readRules(input.source);
  const reviewed = included.map((i) => i.chunk).join('');
  const defs = input.definitions && included.length ? await input.definitions(reviewed) : undefined;
  const contextPages = buildPages([
    { kind: 'diff', parts: included.map((i) => redactSecrets(i.chunk)) },
    ...(defs?.text ? [{ kind: 'definitions', parts: defs.text.split(/(?=^### )/m), preface: DEFINITIONS_PREFACE }] : []),
    ...(rules ? [{ kind: 'team-rules', parts: [redactSecrets(rules)] }] : []),
  ]);

  // Tier from what is actually reviewed, so unreadable or excluded files do not inflate it.
  const tier = included.length === 0 ? 'skip' : risk.tier;
  return {
    baseSha: input.baseSha,
    head: input.head,
    tier,
    reasons: risk.reasons,
    specialists: selectSpecialists({ tier, depth: input.depth, hasRules: rules.length > 0, hasIssue: false }),
    files: included.map(({ file: f }) => ({ path: f.path, status: f.status, addedLines: f.addedLines.length, removedLines: f.removedCount })),
    skipped,
    notIncluded,
    contextPages,
    changedSymbols: changedSymbols(reviewed),
    ...(defs ? { definitions: defs.summary } : {}),
    source: input.source,
    ...(input.remote ? { remote: input.remote } : {}),
    reviewedDiff: reviewed,
    ...(input.onlyFiles ? { incremental: { since: input.onlyFiles.since, files: [...input.onlyFiles.files].sort() } } : {}),
    ticketRefs: extractIssueRefs(input.refText ?? '', input.refHost ?? 'github.com').map(issueRefLabel),
  };
}

/** A local review: head against base in this clone. Pass `lookup` to add definitions from the code graph. */
export async function buildPlan(repo: GitRepo, base: string | undefined, head: Head, depth: Depth, lookup?: Pick<DefinitionsDeps, 'graph' | 'waitMs'>, since?: string): Promise<ReviewPlan> {
  const headSha = head === 'worktree' ? head : await repo.resolveCommit(head);
  const baseSha = base ? await repo.resolveCommit(base) : await repo.defaultBase(headSha === 'worktree' ? 'HEAD' : headSha);
  const source = new RevisionSource(repo, headSha);
  const skipped: SkippedFile[] = [];
  const notIncluded: string[] = [];
  let rawDiff = await repo.diff(baseSha, headSha);
  if (headSha === 'worktree') rawDiff += await collectUntracked(repo, source, skipped, notIncluded);
  const sinceSha = since ? await repo.resolveCommit(since) : undefined;
  const onlyFiles = sinceSha ? { since: sinceSha, files: await repo.changedPaths(sinceSha, headSha) } : undefined;
  return assemblePlan({
    ...(onlyFiles ? { onlyFiles } : {}),
    refText: await repo.refText(baseSha, headSha),
    baseSha,
    head: headSha,
    rawDiff,
    source,
    depth,
    skipped,
    notIncluded,
    ...(lookup ? { definitions: (reviewed: string) => repoDefinitions(reviewed, { repo, head: headSha, source, ...lookup }) } : {}),
  });
}

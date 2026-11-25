import { definitionsText, isSecretPath, isSkippablePath, locateDefinitions, parseUnifiedDiff, type Depth, type FileSymbols } from '@repospector/core';
import { extractSymbols } from '../graph/parser.js';
import { assemblePlan, type ReviewPlan } from '../plan.js';
import type { PlanDefinitions } from '../repo-definitions.js';
import { definitionNames, IntakeError, neededFiles, type Intake } from './intake.js';
import type { MemorySource } from './memory-source.js';

/** Same cap as the local and extension paths. */
const MAX_DEFINITION_FILES = 30;

async function parseProvided(source: MemorySource): Promise<Map<string, FileSymbols>> {
  const out = new Map<string, FileSymbols>();
  for (const path of source.paths()) {
    const symbols = await extractSymbols(path, source.lines(path)?.join('\n') ?? '');
    if (symbols) out.set(path, symbols);
  }
  return out;
}

/**
 * Definitions of what the reviewed diff calls, located in the files the agent provided (parsed with
 * tree-sitter) rather than a whole-repo graph: the agent found them with its host's code search.
 */
export async function providedDefinitions(reviewed: string, source: MemorySource): Promise<{ text: string; summary: PlanDefinitions }> {
  const names = definitionNames(reviewed);
  const parsed = await parseProvided(source);
  const added = new Map(parseUnifiedDiff(reviewed).map((f) => [f.path, new Set(f.addedLines)] as const));
  const located = locateDefinitions(parsed, names, added);
  const sites = located.found.filter((s) => !isSecretPath(s.file) && !isSkippablePath(s.file));
  const files = new Set([...new Set(sites.map((s) => s.file))].slice(0, MAX_DEFINITION_FILES));
  const { text, used } = definitionsText(sites.filter((s) => files.has(s.file)), (f) => source.lines(f)?.join('\n'));
  const missing = located.missing.length ? ` Not found in the provided files: ${located.missing.slice(0, 8).join(', ')}.` : '';
  const note = used.length
    ? `Added ${used.length} definitions of code the diff calls, from ${parsed.size} provided files.${missing}`
    : `No definitions added: nothing the diff calls is defined in the ${parsed.size} provided files.${missing}`;
  return { text, summary: { used: used.length, indexedFiles: parsed.size, note } };
}

/** The plan for a pull/merge request fetched through the agent's MCP tools. Refuses until the changed files are provided. */
export async function buildRemotePlan(intake: Intake, depth: Depth): Promise<ReviewPlan> {
  const pr = intake.pr;
  if (!pr) throw new IntakeError('call provide_pr first, with the pull request data from your GitHub/GitLab MCP tools');
  const missing = neededFiles(pr.diff).filter((p) => !intake.source.has(p));
  if (missing.length) {
    throw new IntakeError(`provide the head-commit content of ${missing.length} changed file(s) first: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
  }
  return assemblePlan({
    baseSha: pr.baseSha,
    head: pr.headSha,
    rawDiff: pr.diff,
    source: intake.source,
    depth,
    skipped: pr.noPatch.map((path) => ({ path, reason: 'no patch from the host (binary or too large)' })),
    definitions: (reviewed) => providedDefinitions(reviewed, intake.source),
    remote: { url: intake.url, diff: pr.diff },
    refText: `${pr.title}\n${pr.body}`,
    refHost: intake.target.host,
    ...(pr.changedSince ? { onlyFiles: { since: pr.changedSince.sha, files: pr.changedSince.files } } : {}),
  });
}

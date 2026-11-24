import { calledNames, definitionsText, isSecretPath, isSkippablePath, locateDefinitions, parseUnifiedDiff } from '@repospector/core';
import { MAX_PARSED_FILES, parseFiles } from './context.js';
import type { GitRepo, Head } from './git.js';
import type { GraphService } from './graph/service.js';
import type { FileSymbols } from './graph/parser.js';
import type { RevisionSource } from './source.js';

/** How long plan_review waits for the code graph of the reviewed commit (first build of a big repo). */
export const DEFINITIONS_WAIT_MS = 120_000;
/** Files read for definitions are capped (the text is capped too); same as the extension. */
export const MAX_DEFINITION_FILES = 30;

export interface PlanDefinitions {
  /** Definitions put in the context pack. */
  readonly used: number;
  /** Files in the code graph they were looked up in (0 when no lookup ran). */
  readonly indexedFiles: number;
  readonly note: string;
}

export interface DefinitionsDeps {
  readonly repo: GitRepo;
  readonly head: Head;
  readonly source: RevisionSource;
  readonly graph?: GraphService | undefined;
  readonly waitMs?: number;
}

const none = (note: string, indexedFiles = 0): { text: string; summary: PlanDefinitions } => ({ text: '', summary: { used: 0, indexedFiles, note } });

/** Every indexed file's symbols at the reviewed revision: the commit's graph, with uncommitted files parsed now. */
async function symbolsAtHead(d: DefinitionsDeps & { graph: GraphService }): Promise<Map<string, FileSymbols> | undefined> {
  const commit = d.head === 'worktree' ? await d.repo.resolveCommit('HEAD') : d.head;
  const committed = await d.graph.allSymbolsAt(commit, d.waitMs ?? DEFINITIONS_WAIT_MS);
  if (!committed || d.head !== 'worktree') return committed;
  const dirty = [...(await d.repo.dirtyPaths())];
  for (const p of dirty) committed.delete(p); // deleted or changed: the committed symbols are stale
  const parsed = await parseFiles(dirty.slice(0, MAX_PARSED_FILES), d.source);
  return new Map([...committed, ...parsed]);
}

/**
 * Code of what the diff's added lines call, construct or extend, from the rest of the repository at
 * the reviewed revision: the same step the extension runs before its second review pass. Empty text
 * with a note saying why when nothing is found or the graph is unavailable (get_context still works).
 */
export async function repoDefinitions(diff: string, d: DefinitionsDeps): Promise<{ text: string; summary: PlanDefinitions }> {
  const names = calledNames(diff);
  if (names.length === 0) return none('The diff calls nothing that could be defined elsewhere in the repository.');
  if (!d.graph) return none('No definitions added: the code graph needs Node 22.13 or later. Specialists can still call get_context.');
  let symbols: Map<string, FileSymbols> | undefined;
  try {
    symbols = await symbolsAtHead({ ...d, graph: d.graph });
  } catch (e) {
    console.error('[repospector] definitions lookup failed:', (e as Error).message);
  }
  if (!symbols) return none('No definitions added: the code graph was not ready in time. Specialists can still call get_context.');
  const added = new Map(parseUnifiedDiff(diff).map((f) => [f.path, new Set(f.addedLines)] as const));
  const located = locateDefinitions(symbols, names, added);
  const sites = located.found.filter((s) => !isSecretPath(s.file) && !isSkippablePath(s.file));
  const files = [...new Set(sites.map((s) => s.file))].slice(0, MAX_DEFINITION_FILES);
  await d.source.preload(files);
  const readable = new Set(files);
  const { text, used } = definitionsText(sites.filter((s) => readable.has(s.file)), (f) => d.source.lines(f)?.join('\n'));
  if (used.length === 0) return none(`Nothing the diff calls is defined elsewhere in the ${symbols.size} indexed files.`, symbols.size);
  const skipped = located.ambiguous.length ? ` Left out, defined in too many places: ${located.ambiguous.slice(0, 5).join(', ')}.` : '';
  return { text, summary: { used: used.length, indexedFiles: symbols.size, note: `Added ${used.length} definitions of code the diff calls, from ${symbols.size} indexed files.${skipped}` } };
}

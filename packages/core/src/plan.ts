import type { Category } from './finding.js';
import type { RiskTier } from './risk.js';

export type Depth = 'quick' | 'standard' | 'deep';

export interface PlanInput {
  readonly tier: RiskTier;
  readonly depth: Depth;
  /** Repo has team rules (.RepoSpector/rules.md, CLAUDE.md, AGENTS.md). */
  readonly hasRules: boolean;
  /** A linked issue with requirements is available. */
  readonly hasIssue: boolean;
}

const ORDER: readonly Category[] = ['logic', 'security', 'concurrency', 'tests', 'duplication', 'rules', 'requirements'];

/** Which specialists run. Depth goes where the risk is; trivial changes get one combined pass. */
export function selectSpecialists(input: PlanInput): Category[] {
  if (input.tier === 'skip') return [];
  if (input.depth === 'quick' || (input.tier === 'trivial' && input.depth !== 'deep')) return input.hasIssue && input.depth !== 'quick' ? ['logic', 'requirements'] : ['logic'];

  const chosen = new Set<Category>(['logic', 'security', 'tests']);
  if (input.tier === 'high' || input.depth === 'deep') chosen.add('concurrency');
  if (input.depth === 'deep') chosen.add('duplication');
  if (input.hasRules) chosen.add('rules');
  // A linked issue is the only input this specialist has, so it runs whenever one was provided.
  if (input.hasIssue) chosen.add('requirements');
  return ORDER.filter((c) => chosen.has(c));
}

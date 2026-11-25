import type { CiCheck, Diagnostic, JudgeResult, LinkedIssue, PrSummary, ReviewRun } from '@repospector/core';
import type { RememberedFindingT } from './history.js';
import type { ReviewPlan } from './plan.js';

export interface StoredRun {
  readonly run: ReviewRun;
  /** Replaced when issues are added (the context pack gains a page). */
  plan: ReviewPlan;
  /** Set once by finalize; post_review reads it. */
  final?: JudgeResult;
  /** Walkthrough written by the orchestrating agent (submit_summary). */
  summary?: PrSummary | undefined;
  /** Linked issues and tickets the agent fetched (provide_issues). */
  issues?: LinkedIssue[] | undefined;
  /** Check results (CI or approved local commands) and their diagnostics on changed lines, with ids c1, c2, … */
  checks?: { readonly results: CiCheck[]; readonly diagnostics: (Diagnostic & { readonly id: string; readonly fingerprint: string })[] } | undefined;
  /** Earlier findings in files this re-review did not cover. */
  carried?: RememberedFindingT[] | undefined;
  /** History key: the PR URL target or the local branch. */
  historyKey?: string;
}

/** In-memory runs for this server process, bounded so a long session cannot grow without limit. */
export class RunStore {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly capacity = 20) {}

  add(entry: StoredRun): void {
    this.runs.set(entry.run.id, entry);
    while (this.runs.size > this.capacity) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  get(id: string): StoredRun | undefined {
    return this.runs.get(id);
  }
}

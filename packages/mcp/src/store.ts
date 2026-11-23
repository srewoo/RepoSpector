import type { JudgeResult, ReviewRun } from '@repospector/core';
import type { ReviewPlan } from './plan.js';

export interface StoredRun {
  readonly run: ReviewRun;
  readonly plan: ReviewPlan;
  /** Set once by finalize; post_review reads it. */
  final?: JudgeResult;
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

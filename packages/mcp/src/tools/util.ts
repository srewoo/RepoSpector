import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RunStateError } from '@repospector/core';
import { z } from 'zod';
import { FeedbackError, type FeedbackLog } from '../feedback.js';
import { GitError, type GitRepo } from '../git.js';
import type { GraphService } from '../graph/service.js';
import type { ReviewHistory } from '../history.js';
import { HostError, ReviewUrlError, type CliRunner } from '../hosts/index.js';
import type { ReviewPlan } from '../plan.js';
import { IntakeError, type Intake } from '../remote/intake.js';
import type { RunStore, StoredRun } from '../store.js';

export class ToolError extends Error {}

export const RunId = z.string().min(1).max(64);
export const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const KNOWN = [GitError, ToolError, HostError, ReviewUrlError, FeedbackError, IntakeError];

/** Known errors go back to the agent verbatim; anything else is logged and returned generically. */
export async function handle(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    let text = 'internal error; see the server log';
    if (e instanceof RunStateError) text = `${e.code}: ${e.message}`;
    else if (KNOWN.some((k) => e instanceof k)) text = (e as Error).message;
    else console.error('[repospector] tool failed:', e);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export interface ServerOptions {
  readonly root: string;
  /** Where the code graph is stored; default REPOSPECTOR_CACHE_DIR or ~/.cache/repospector. */
  readonly cacheDir?: string;
  /** How long get_context waits for a graph build before parsing on demand. */
  readonly graphWaitMs?: number;
  /** How long plan_review waits for the graph to add definitions to the context pack (default 2 minutes). */
  readonly definitionsWaitMs?: number;
  /** Runs gh/glab; tests pass a fake. */
  readonly cliRunner?: CliRunner;
}

/** Everything the tool groups share. `repo` is undefined when the server was started outside a git repository. */
export interface ToolContext {
  readonly server: McpServer;
  readonly opts: ServerOptions;
  readonly repo: GitRepo | undefined;
  readonly graph: GraphService | undefined;
  readonly store: RunStore;
  readonly intakes: Map<string, Intake>;
  /** Last finalized review per pull/merge request or local branch (re-reviews). */
  readonly history: ReviewHistory;
  getRun(runId: string): StoredRun;
  requireRepo(): GitRepo;
  /** This user's local reactions for the reviewed repository (the clone, or the remote project). */
  feedbackFor(plan: Pick<ReviewPlan, 'remote'>): FeedbackLog;
}

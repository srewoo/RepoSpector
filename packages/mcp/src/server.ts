import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FeedbackLog } from './feedback.js';
import { GitError, GitRepo } from './git.js';
import { defaultCacheDir, GraphService } from './graph/service.js';
import type { Intake } from './remote/intake.js';
import { registerRemoteTools } from './remote/tools.js';
import { ReviewHistory } from './history.js';
import { RunStore } from './store.js';
import { registerExtraTools } from './tools/extras.js';
import { registerReviewTools } from './tools/review.js';
import { registerTeamTools } from './tools/team.js';
import { ToolError, type ServerOptions, type ToolContext } from './tools/util.js';
import { VERSION } from './version.js';

export { VERSION };
export type { ServerOptions };

/** The clone at `root`, or undefined when the server runs outside a git repository (pull/merge request reviews still work). */
async function openRepo(root: string): Promise<GitRepo | undefined> {
  try {
    return await GitRepo.open(root);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    console.error(`[repospector] ${e.message}: local reviews are off; review pull/merge requests by URL with start_pr_review`);
    return undefined;
  }
}

export async function createServer(opts: ServerOptions): Promise<McpServer> {
  const repo = await openRepo(opts.root);
  const graph = repo ? await GraphService.open(repo, opts.cacheDir) : undefined;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const store = new RunStore();
  const server = new McpServer({ name: 'repospector', version: VERSION });
  const requireRepo = (): GitRepo => {
    if (!repo) throw new ToolError(`${opts.root} is not a git repository, so local reviews are off. To review a pull/merge request, call start_pr_review with its URL.`);
    return repo;
  };
  const ctx: ToolContext = {
    server,
    opts,
    repo,
    graph,
    store,
    intakes: new Map<string, Intake>(),
    history: new ReviewHistory(cacheDir),
    requireRepo,
    getRun: (runId) => {
      const entry = store.get(runId);
      if (!entry) throw new ToolError(`unknown run ${runId}; runs live only as long as this server process`);
      return entry;
    },
    // Reactions are kept per repository: the local clone, or the remote project of a pull/merge request.
    feedbackFor: (plan) => FeedbackLog.forRepo(plan.remote ? remoteKey(plan.remote.url) : requireRepo().root, cacheDir),
  };
  registerReviewTools(ctx);
  registerTeamTools(ctx);
  registerRemoteTools(ctx);
  registerExtraTools(ctx);
  return server;
}

/** host/owner/repo of a pull/merge request URL: one feedback log per remote repository. */
function remoteKey(url: string): string {
  const m = url.match(/^https:\/\/([^/]+)\/(.+?)\/(?:-\/merge_requests|pull)\/\d+/i);
  return `remote:${(m?.[1] ?? '').toLowerCase()}/${m?.[2] ?? url}`;
}

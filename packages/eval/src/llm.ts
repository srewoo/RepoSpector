import { spawn } from 'node:child_process';

export interface LlmReply {
  readonly text: string;
  readonly costUsd: number;
  /** Model turns in the call; above 1 means it used tools. */
  readonly turns: number;
}

export interface LlmOptions {
  readonly model: string;
  readonly system?: string;
  /** Read-only tools to allow (e.g. Read, Grep, Glob). Default: none. */
  readonly tools?: readonly ('Read' | 'Grep' | 'Glob')[];
  /** Working directory for the call, e.g. a PR worktree. */
  readonly cwd?: string;
  readonly maxBudgetUsd?: number;
  /** MCP server config file; only its servers load (--strict-mcp-config). */
  readonly mcpConfig?: string;
  /** MCP tools to allow, e.g. mcp__ctx__get_context. */
  readonly mcpTools?: readonly string[];
  /** Effort level (the extension sets high for review, medium for verify). */
  readonly effort?: 'low' | 'medium' | 'high';
}

export interface LlmClient {
  complete(prompt: string, opts: LlmOptions): Promise<LlmReply>;
}

/** One model call through the user's own Claude Code session: no tools, no MCP, nothing saved. */
export function buildClaudeArgs(opts: LlmOptions): string[] {
  // --setting-sources "" keeps a reviewed repo's .claude settings (hooks) and CLAUDE.md out of the session.
  const tools = (opts.tools ?? []).join(',');
  const allowed = [...(opts.tools ?? []), ...(opts.mcpTools ?? [])].join(',');
  const args = ['-p', '--model', opts.model, '--tools', tools, '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json'];
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  if (allowed) args.push('--allowedTools', allowed);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  // An empty string is meaningful: it replaces Claude Code's default system prompt with none.
  if (opts.system !== undefined) args.push('--system-prompt', opts.system);
  if (opts.effort) args.push('--effort', opts.effort);
  return args;
}

export function parseClaudeOutput(stdout: string): LlmReply {
  let env: { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; num_turns?: unknown };
  try {
    env = JSON.parse(stdout) as typeof env;
  } catch {
    throw new Error(`claude returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (env.is_error === true || typeof env.result !== 'string') {
    throw new Error(`claude call failed: ${String(env.result ?? 'no result').slice(0, 300)}`);
  }
  return {
    text: env.result,
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0,
    turns: typeof env.num_turns === 'number' ? env.num_turns : 1,
  };
}

function runOnce(prompt: string, opts: LlmOptions, timeoutMs: number): Promise<LlmReply> {
  return new Promise((resolve, reject) => {
    // Prompt goes on stdin so its size is not limited by argv and it never appears in `ps`.
    const child = spawn('claude', buildClaudeArgs(opts), { stdio: ['pipe', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(parseClaudeOutput(out));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(prompt);
  });
}

/** Claude CLI client with a concurrency limit and bounded retries. */
export class ClaudeCliClient implements LlmClient {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  totalCostUsd = 0;
  calls = 0;

  constructor(
    private readonly concurrency = 4,
    private readonly timeoutMs = 600_000,
    private readonly retries = 2,
  ) {}

  async complete(prompt: string, opts: LlmOptions): Promise<LlmReply> {
    await this.acquire();
    try {
      let last: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          const reply = await runOnce(prompt, opts, this.timeoutMs);
          this.totalCostUsd += reply.costUsd;
          this.calls++;
          return reply;
        } catch (e) {
          last = e;
        }
      }
      throw last;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

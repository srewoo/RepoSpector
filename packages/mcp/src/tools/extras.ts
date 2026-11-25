import { checksLine, diagnosticFingerprint, issuesText, onChangedLines, parseToolOutput, redactSecrets, toRepoPath, type CiCheck, type Diagnostic } from '@repospector/core';
import { z } from 'zod';
import { buildPages } from '../pack.js';
import { handle, RunId, SAFE, ToolError, type ToolContext } from './util.js';

/**
 * Inputs the orchestrating agent gathers with its own tools and hands over: linked issues and
 * tickets (GitHub/GitLab issues, Jira or Linear through their MCP servers), a walkthrough summary,
 * and check results (CI from the host, or local commands the user approved). Repository content and
 * tool output are untrusted data; they are validated, capped and secret-masked here.
 */
const Issue = z
  .object({
    ref: z.string().min(1).max(100).describe('e.g. "#12", "owner/repo#12", "ABC-123"'),
    title: z.string().max(500),
    body: z.string().max(50_000),
    url: z.string().max(500).optional(),
  })
  .strict();

const Annotation = z
  .object({ file: z.string().max(1000), line: z.number().int().min(1), level: z.enum(['error', 'warning', 'notice']).optional(), message: z.string().min(1).max(2000) })
  .strict();

const Check = z
  .object({
    name: z.string().min(1).max(200).describe('Check or command name, e.g. "lint" or "CI: test"'),
    status: z.enum(['passed', 'failed', 'pending', 'skipped']).optional().describe('Default: failed when exitCode is non-zero, else passed'),
    command: z.string().max(500).optional(),
    exitCode: z.number().int().optional(),
    output: z.string().max(400_000).optional().describe('Command or job log output (the last part is enough)'),
    annotations: z.array(Annotation).max(500).optional().describe('Line annotations from CI (GitHub check-run annotations)'),
    url: z.string().max(500).optional(),
  })
  .strict();

function registerIssues(c: ToolContext): void {
  c.server.registerTool(
    'provide_issues',
    {
      description:
        "Hand over the issues or tickets this change addresses (GitHub/GitLab issues, Jira or Linear tickets), fetched with your connected tools: the plan's ticketRefs, or a ticket the user named. Adds them to the context pack and adds the requirements specialist. Call before starting specialists.",
      inputSchema: { runId: RunId, issues: z.array(Issue).min(1).max(3) },
      annotations: SAFE,
    },
    async ({ runId, issues }) =>
      handle(async () => {
        const entry = c.getRun(runId);
        if (entry.run.state().stage !== 'reviewing') throw new ToolError('the review stage is closed; provide issues before verify_batch');
        if (entry.issues) throw new ToolError('issues were already provided for this run');
        entry.issues = issues.map((i) => ({ ...i, body: redactSecrets(i.body) }));
        entry.run.addSpecialist('requirements');
        const pages = buildPages([{ kind: 'linked-issues', parts: [issuesText(entry.issues)] }]);
        entry.plan = { ...entry.plan, contextPages: [...entry.plan.contextPages, ...pages] };
        return { specialists: entry.run.specialists, contextPackPages: entry.plan.contextPages.length, next: 'Start the requirements specialist too, with the whole context pack (the issues are on the last page).' };
      }),
  );
}

function registerSummary(c: ToolContext): void {
  c.server.registerTool(
    'submit_summary',
    {
      description:
        'Store a walkthrough of the change for the result and the posted review body: a short overview, one line per changed file, and up to 3 places a reviewer should read closely. Write it yourself from the context pack; it is a description, not a finding.',
      inputSchema: {
        runId: RunId,
        overview: z.string().min(1).max(1200),
        files: z.array(z.object({ path: z.string().max(300), change: z.string().max(300) }).strict()).max(200),
        focus: z.array(z.string().max(400)).max(3).optional(),
      },
      annotations: SAFE,
    },
    async ({ runId, overview, files, focus }) =>
      handle(async () => {
        const entry = c.getRun(runId);
        entry.summary = { overview: redactSecrets(overview), files: files.map((f) => ({ path: f.path, change: redactSecrets(f.change) })), focus: (focus ?? []).map(redactSecrets) };
        return { stored: true };
      }),
  );
}

function toDiagnostics(check: z.infer<typeof Check>, root: string): Diagnostic[] {
  const fromOutput = check.output ? parseToolOutput(check.name, check.output.slice(-200_000), root) : [];
  const fromAnnotations = (check.annotations ?? []).flatMap((a) => {
    const file = toRepoPath(a.file, root);
    return file ? [{ source: check.name, file, line: a.line, level: a.level ?? 'error', message: redactSecrets(a.message).slice(0, 500) } satisfies Diagnostic] : [];
  });
  return [...fromAnnotations, ...fromOutput];
}

function registerChecks(c: ToolContext): void {
  c.server.registerTool(
    'submit_check_results',
    {
      description:
        "Hand over results of linters, type checkers, scanners or tests: CI results you read with your GitHub/GitLab tools (check runs, annotations, failed job logs), or the output of local commands from the plan's localChecks that the user approved and you ran. Line problems on the changed lines are reported with the result (ids c1, c2, …) and can be posted; tool output is never given to the reviewers as instructions.",
      inputSchema: { runId: RunId, checks: z.array(Check).min(1).max(30) },
      annotations: SAFE,
    },
    async ({ runId, checks }) =>
      handle(async () => {
        const entry = c.getRun(runId);
        const root = c.repo?.root ?? '';
        const prior = entry.checks?.results ?? [];
        const results: CiCheck[] = [
          ...prior,
          ...checks.map((k) => {
            const status = k.status ?? (k.exitCode !== undefined && k.exitCode !== 0 ? 'failed' : 'passed');
            return { name: k.name, status, url: k.url, summary: k.command, diagnostics: toDiagnostics(k, root) } satisfies CiCheck;
          }),
        ];
        const onDiff = onChangedLines(results.flatMap((r) => r.diagnostics), entry.plan.reviewedDiff).slice(0, 100);
        entry.checks = { results, diagnostics: onDiff.map((d, i) => ({ ...d, id: `c${i + 1}`, fingerprint: diagnosticFingerprint(d) })) };
        return { summary: checksLine(results), onChangedLines: entry.checks.diagnostics.length, diagnostics: entry.checks.diagnostics.slice(0, 30).map(({ fingerprint: _f, ...d }) => d) };
      }),
  );
}

export function registerExtraTools(c: ToolContext): void {
  registerIssues(c);
  registerSummary(c);
  registerChecks(c);
}

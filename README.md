# RepoSpector

Open-source AI code review for GitHub and GitLab. See `RepoSpector.md` for the product and technical spec, and `PLAN.md` for build status.

This repo contains the shared review core, the eval harness, an MCP server that runs reviews on your own Claude Code or Codex session with no API key (local changes, or any GitHub/GitLab PR/MR by URL through your connected GitHub/GitLab MCP), and the Chrome extension.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Finding and verdict schemas, fingerprints, diff parser, evidence check, judge, risk tier, specialist selection, prompts, run state machine. No I/O; runs in Node and the browser. |
| `packages/eval` | Golden-case format and a scorer for precision, recall and F1. |
| `packages/mcp` | Local MCP server (`repospector-mcp`) and the Claude Code plugin in `packages/mcp/plugin`. |

## Develop

```sh
npm install
npm run check   # typecheck + tests
npm run build
```

Node 22 or later.

## Use the MCP server locally

```sh
npm run build
claude mcp add repospector -- node /absolute/path/to/packages/mcp/dist/index.js
```

The server reviews the git repo it starts in (or `--repo <dir>`). Then load the skill in `packages/mcp/plugin/skills/repospector` and run `/repospector`.

The plugin pins the exact `repospector-mcp` version from `packages/mcp/package.json`, so it never silently runs an older release (npm's `repospector-mcp` up to 0.6.0 is the previous codebase).

## Releasing

Versions live only in each `package.json`; `npm run build` copies them into the code, the extension manifest, the plugin and the docs (`scripts/sync-versions.mjs`), and a test fails if they drift.

- **Chrome Web Store:** set `version` in `packages/extension/package.json` (1–4 numbers, higher than the published one), then `npm run package:extension`. Upload `packages/extension/release/repospector-extension-<version>.zip`.
- **npm:** set `version` in `packages/mcp/package.json` (MAJOR.MINOR.PATCH, higher than the published one), commit, then `npm run release:mcp -- --dry-run` and `npm run release:mcp`. It builds, runs every test, bundles `@repospector/core` in (it is not on npm), installs the packed tarball into an empty folder and checks it answers `--version`, `native status` and an MCP handshake, and only then publishes. You need to be logged in to npm (`npm login`).

## Review a pull request or merge request by URL

In Claude Code, ask: "review this MR with repospector: <link>". The repository does not need to be cloned, and the server can run outside any git repository.

RepoSpector cannot call another MCP server, and it does not use `gh`/`glab` for this. Your agent fetches everything with the GitHub or GitLab MCP server you have connected, and RepoSpector checks what it is given:

1. `start_pr_review(url)` returns a `reviewId` and the steps.
2. The agent fetches the PR/MR (head and base commit ids, title, changed files with patches) and calls `provide_pr`.
3. The agent fetches each changed file at the head commit, plus the files that define what the diff calls (found with the host's code search), and calls `provide_files`. Content is checked against the git blob id the host reports (a dropped final newline is repaired; any other difference is refused). Secret files (`.env`, keys) are refused and never sent to a model. Files cannot be replaced within a review.
4. `plan_review(reviewId)` builds the same plan as a local review. Repository context is the definitions, parsed with tree-sitter, found in the provided files. `get_context` searches the provided files only.
5. Specialists, verifier and `finalize` run as below. A finding can cite only files that were provided. `post_review` returns the draft (a pending review, or draft notes) for the agent to post through the same MCP server, and only to the same PR/MR.

Cost: file contents pass through the agent, so they count as its output tokens. Large PRs cost more than a local review of the same change.

## How a review runs

1. `plan_review` diffs head against base (by default your working tree, including untracked files, against the merge-base with main). It skips lockfiles, generated, binary and deleted files, rates the risk, and picks specialists.
2. Each specialist subagent calls `submit_findings`. While reviewing it can call `get_context(runId, symbol)` to see where a function, class or field is defined and used at the reviewed revision; `plan_review` lists the `changedSymbols` worth checking. Candidate files are found by text search and then parsed with tree-sitter (Python, Go, Java, Ruby, JavaScript, TypeScript, TSX), so definitions, calls and the calling function are exact; other languages fall back to text matches marked `kind: "text"`. Callers stay a tool the agent calls: on Martian's held-out PRs, pushing caller context into the review prompt did not raise recall. Definitions are different: `plan_review` puts the code (first 20 lines) of what the diff's added lines call, construct or extend into the context pack, looked up in the whole-repo code graph at the reviewed revision (uncommitted files parsed as they are now; test files, definitions the diff adds, and names defined in more than 3 places left out; at most 30 files, 60k chars, secrets masked). This is the step the browser extension runs before its second review pass; measured alone it was neutral to slightly positive (recall 66.4 vs 66.1). `plan_review` waits up to 2 minutes for the graph on a first build; if it is not ready, the plan says so and the review goes on with the diff and `get_context`. A finding is rejected if its location or evidence points at lines that don't exist.
3. `verify_batch` closes review and returns each finding's claim and cited code for a fresh verifier. The specialist's reasoning and confidence are withheld so the verifier checks the code, not the argument.
4. `finalize` refuses unless every finding has exactly one verdict citing real code. Refuted and low-confidence findings are kept and labeled `suspected`, after the `verified` ones; only duplicates are removed. On Martian's held-out PRs, deleting refuted findings cost more real bugs than it saved noise.

**Code graph.** `plan_review` builds a per-commit code graph (definitions, calls with their calling function, and extends/implements links, parsed with tree-sitter). It is stored locally in SQLite under `$REPOSPECTOR_CACHE_DIR` (default `~/.cache/repospector`), keyed by file content, so later commits only re-parse changed files. Nothing in it leaves your machine. It needs Node 22.13 or later for `node:sqlite`; on older Node, `get_context` parses matching files on demand instead. Delete the cache directory at any time to reset it.

5. `post_review` (optional, on request) puts findings on a GitHub pull request or GitLab merge request as drafts: a pending review on GitHub, draft notes on GitLab. Only you see them until you publish. It uses your existing `gh` or `glab` login (GitHub Enterprise and self-managed GitLab work via the URL's host); the server stores no token. Without a `gh`/`glab` login it posts nothing and returns the draft (`handoff`) for your agent to post with a GitHub or GitLab MCP server you have connected, with rules it must follow: confirm with you, check the PR head and existing markers, never submit or publish (`via`: `auto` default, `cli`, `agent`). It previews by default (`dryRun`), refuses if the PR head is not the reviewed commit, puts findings outside the changed lines in the review summary, skips findings already posted (hidden fingerprint marker), and defuses @mentions and secrets in the text.

6. `record_feedback` stores your reaction to a finding (accepted or rejected, with a reason) on this machine. On later reviews, a finding you rejected, or one similar to 3 or more rejected comments in the same category, is shown as `suspected` with the reason; it is never hidden. `export_feedback` merges your reactions into `.RepoSpector/feedback.jsonl` so the team shares them by committing the file; every review reads that file too. Similarity is word overlap for now; the spec's on-device embeddings can replace it behind the same function.

What the server can and cannot guarantee: it enforces order and completeness. It cannot prove the verifier ran in a fresh context; that is up to the client following the skill.

The context pack is returned in pages of about 40,000 characters (`contextPackPages`; `get_context_pack(runId, page)` for the rest). Claude Code saves larger tool results to a file instead of passing them on, so subagents never saw a large pack.

**Before the specialists** (all optional, all handed over by the agent, since the server calls no model and no other MCP server):
- `provide_issues(runId, issues)`: issues or tickets the change addresses (GitHub/GitLab issues, Jira or Linear through their MCP servers). `plan_review` lists `ticketRefs` it found in the branch name, commit subjects, or PR title and body (`#12`, `owner/repo#12`, `ABC-123`). Adds a `linked-issues` page to the context pack and the `requirements` specialist.
- `submit_check_results(runId, checks)`: linters, type checkers, scanners and tests. For local reviews `plan_review` lists `localChecks`, the repository's own commands (package.json scripts, ruff, mypy, pytest, go vet/test, cargo clippy/test, rubocop, make lint/test); they run code from the repository, so the agent runs only those the user approves. For URL reviews the agent passes CI check runs, annotations or failed job logs. Problems on lines the change adds get ids `c1`, `c2`, … and can be posted.
- `submit_summary(runId, …)`: a walkthrough the agent writes; it heads the result and the posted review body.

**Re-review.** The server remembers the last finalized review per PR/MR URL or local branch (`reviews.json` in the cache dir, 0600: file, line, claim and status only). `plan_review` and `start_pr_review` return `previousReview`; `plan_review({ since: "last" })` (local) or `provide_pr({ changedSince })` (URL) reviews only files changed since, and `finalize` returns the earlier findings in other files as `carriedOver`.

**Fixes and posting.** Specialists may add a small `fix` (replacement lines). `post_review` posts it as a one-click suggestion (GitHub ```` ```suggestion ````, GitLab ```` ```suggestion:-N+0 ````) when the lines are in one diff hunk and the text survives cleaning unchanged. At most 15 inline comments by default (`maxInline`), most likely first; the rest are listed in the review body.

**Model.** The skill tells the orchestrating agent to start every subagent on its own model, overriding a configured default subagent model, so the user's choice of model applies to the whole review. Specialists report a `basis` (code facts) instead of the earlier `reasoning` field (still accepted), and a specialist stopped by a safeguard is started once more before it is skipped.

If a specialist subagent fails or is stopped, for example by a model safety safeguard, `skip_specialist(runId, specialist, reason)` lets the run finish. `finalize` lists that area under `coverage.notCovered`, and the summary names it.

Confidence is labeled "uncalibrated" until calibration tables are measured on the golden set.

## Score a reviewer

```sh
node packages/eval/dist/cli.js score --cases cases.json --predictions predictions.json [--tolerance 5] [--split heldout] [--json]
```

`predictions.json` maps case id to an array of `{ file, startLine, endLine, claim }`. A prediction matches a labeled issue in the same file within the line tolerance, one to one. Line matching is deterministic but stricter than an LLM judge: a correct finding placed on a different line counts as a miss. Use it to compare setups on the same cases, not as a substitute for Martian's judged scores.

## Known gaps

- The golden sets are small (Martian's 50 PRs, 30 regression cases); gains under ~5 recall points cannot be resolved yet.
- The feedback filter matches by word overlap; the embedding model in the spec is not built yet.
- Runs live in memory and are lost when the server restarts (the last finalized review per target is remembered for re-reviews).
- No GitHub Action / CI mode yet: reviews start from the extension or an agent session.
- The Chrome extension (`packages/extension`) is not yet on the Chrome Web Store, and has not posted to a real pull request yet.
- The extension's local mode needs the `repospector-mcp` version in `packages/mcp/package.json` on npm. Until it is published, register the host from a checkout: `node packages/mcp/dist/index.js native install --extension-id <id> --repo <path>`.

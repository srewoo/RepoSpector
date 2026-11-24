# RepoSpector

Open-source AI code review for GitHub and GitLab. See `RepoSpector.md` for the product and technical spec, and `PLAN.md` for build status.

This repo currently contains the foundation: the shared review core, the eval harness, and a local MCP server that runs reviews on your own Claude Code or Codex session with no API key. The Chrome extension is not built yet.

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

## How a review runs

1. `plan_review` diffs head against base (by default your working tree, including untracked files, against the merge-base with main). It skips lockfiles, generated, binary and deleted files, rates the risk, and picks specialists.
2. Each specialist subagent calls `submit_findings`. While reviewing it can call `get_context(runId, symbol)` to see where a function, class or field is defined and used at the reviewed revision; `plan_review` lists the `changedSymbols` worth checking. Candidate files are found by text search and then parsed with tree-sitter (Python, Go, Java, Ruby, JavaScript, TypeScript, TSX), so definitions, calls and the calling function are exact; other languages fall back to text matches marked `kind: "text"`. Callers stay a tool the agent calls: on Martian's held-out PRs, pushing caller context into the review prompt did not raise recall. Definitions are different: `plan_review` puts the code (first 20 lines) of what the diff's added lines call, construct or extend into the context pack, looked up in the whole-repo code graph at the reviewed revision (uncommitted files parsed as they are now; test files, definitions the diff adds, and names defined in more than 3 places left out; at most 30 files, 60k chars, secrets masked). This is the step the browser extension runs before its second review pass; measured alone it was neutral to slightly positive (recall 66.4 vs 66.1). `plan_review` waits up to 2 minutes for the graph on a first build; if it is not ready, the plan says so and the review goes on with the diff and `get_context`. A finding is rejected if its location or evidence points at lines that don't exist.
3. `verify_batch` closes review and returns each finding's claim and cited code for a fresh verifier. The specialist's reasoning and confidence are withheld so the verifier checks the code, not the argument.
4. `finalize` refuses unless every finding has exactly one verdict citing real code. Refuted and low-confidence findings are kept and labeled `suspected`, after the `verified` ones; only duplicates are removed. On Martian's held-out PRs, deleting refuted findings cost more real bugs than it saved noise.

**Code graph.** `plan_review` builds a per-commit code graph (definitions, calls with their calling function, and extends/implements links, parsed with tree-sitter). It is stored locally in SQLite under `$REPOSPECTOR_CACHE_DIR` (default `~/.cache/repospector`), keyed by file content, so later commits only re-parse changed files. Nothing in it leaves your machine. It needs Node 22.13 or later for `node:sqlite`; on older Node, `get_context` parses matching files on demand instead. Delete the cache directory at any time to reset it.

5. `post_review` (optional, on request) puts findings on a GitHub pull request or GitLab merge request as drafts: a pending review on GitHub, draft notes on GitLab. Only you see them until you publish. It uses your existing `gh` or `glab` login (GitHub Enterprise and self-managed GitLab work via the URL's host); the server stores no token. Without a `gh`/`glab` login it posts nothing and returns the draft (`handoff`) for your agent to post with a GitHub or GitLab MCP server you have connected, with rules it must follow: confirm with you, check the PR head and existing markers, never submit or publish (`via`: `auto` default, `cli`, `agent`). It previews by default (`dryRun`), refuses if the PR head is not the reviewed commit, puts findings outside the changed lines in the review summary, skips findings already posted (hidden fingerprint marker), and defuses @mentions and secrets in the text.

6. `record_feedback` stores your reaction to a finding (accepted or rejected, with a reason) on this machine. On later reviews, a finding you rejected, or one similar to 3 or more rejected comments in the same category, is shown as `suspected` with the reason; it is never hidden. `export_feedback` merges your reactions into `.RepoSpector/feedback.jsonl` so the team shares them by committing the file; every review reads that file too. Similarity is word overlap for now; the spec's on-device embeddings can replace it behind the same function.

What the server can and cannot guarantee: it enforces order and completeness. It cannot prove the verifier ran in a fresh context; that is up to the client following the skill.

Confidence is labeled "uncalibrated" until calibration tables are measured on the golden set.

## Score a reviewer

```sh
node packages/eval/dist/cli.js score --cases cases.json --predictions predictions.json [--tolerance 5] [--split heldout] [--json]
```

`predictions.json` maps case id to an array of `{ file, startLine, endLine, claim }`. A prediction matches a labeled issue in the same file within the line tolerance, one to one. Line matching is deterministic but stricter than an LLM judge: a correct finding placed on a different line counts as a miss. Use it to compare setups on the same cases, not as a substitute for Martian's judged scores.

## Known gaps

- The golden sets are small (Martian's 50 PRs, 30 regression cases); gains under ~5 recall points cannot be resolved yet.
- The feedback filter matches by word overlap; the embedding model in the spec is not built yet.
- Runs live in memory and are lost when the server restarts.
- The Chrome extension (`packages/extension`) is not yet on the Chrome Web Store, and has not posted to a real pull request yet.
- The extension's local mode needs the `repospector-mcp` version in `packages/mcp/package.json` on npm. Until it is published, register the host from a checkout: `node packages/mcp/dist/index.js native install --extension-id <id> --repo <path>`.

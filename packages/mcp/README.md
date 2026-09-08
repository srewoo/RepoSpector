# repospector-mcp

A standalone [MCP](https://modelcontextprotocol.io) server that exposes RepoSpector's repository-analysis
capabilities — a tree-sitter code graph, local RAG retrieval, git diff context, and a review-material bundle
for a pull or merge request — to Claude Desktop, Claude Code, and Codex over stdio.

**It holds no API key and calls no model.** There is no LLM client anywhere in this package. Your client's
own model does the reasoning; this server supplies the repository evidence a general coding agent lacks.
Embeddings run locally. Nothing leaves your machine unless you ask it to fetch a diff from GitHub or GitLab.

## Install and configure

Runs via `npx`, so there is nothing to install ahead of time.

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "repospector": {
      "command": "npx",
      "args": ["-y", "repospector-mcp"]
    }
  }
}
```

Restart Claude Desktop after saving. You do not need to name a repository here: tell the assistant which
one you mean and it passes the path per call, so one entry serves every repository on your machine.

### Claude Code — `.mcp.json` in your project root

```json
{
  "mcpServers": {
    "repospector": {
      "command": "npx",
      "args": ["-y", "repospector-mcp"]
    }
  }
}
```

Here the server inherits the project's working directory, so it follows whichever project you opened.

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.repospector]
command = "npx"
args = ["-y", "repospector-mcp"]
```

Pin a default repository with `"--repo", "/absolute/path"` if you would rather not rely on the working
directory — worth doing for Claude Desktop, which has no useful one.

## Tools

| Tool | What it does |
| --- | --- |
| `search_code` | Hybrid (lexical + embedding) search over the chunked source, returning ranked snippets with file paths and line spans. |
| `get_symbol` | Looks up a symbol (function, class, method) and returns its definition and location. |
| `find_callers` | Walks the code graph to list call sites of a symbol, with the confidence of each edge. |
| `impact_of_change` | Traces the graph outward from a symbol to estimate blast radius, and reports which of it has test coverage. |
| `get_diff_context` | Returns a diff as windowed hunks, each paired with its graph neighbours. |
| `repo_overview` | Summarises structure, languages, index and graph size, and which parser produced the symbols. |
| `index_repo` | (Re)builds the local index — full or incremental — and reports what changed. |
| `review_pr` | Assembles a review-material bundle for a PR/MR — see the note below. |

Every tool accepts an optional `repo` argument (an absolute path; `~` is expanded) which overrides
`--repo` for that call. `review_pr` and `get_diff_context` additionally accept:

- **`diff`** — unified diff text you already hold. **Preferred**: it needs no network call and no token.
  If your client already has an authenticated GitLab or GitHub MCP server connected, let that server fetch
  the merge request and pass the diff straight across.
- **`pr_url`** — a GitHub PR or GitLab MR link for this server to fetch itself.
- **`range`** — a local git revision range, such as `main..HEAD`.

## Flags and environment variables

- `--repo <path>` — default repository for calls that do not name one. Defaults to the working directory.
- `--max-files <n>` — cap on how many files are read during indexing (default 5000).
- `--max-tool-tokens <n>` — cap on any single tool response, in estimated tokens (**default: 12000**).
  Raise it for `review_pr` on a large diff; lower it if your client's context is tight. The bundle divides
  this budget across its sections rather than truncating from the end, so no section can crowd out the
  others: `hunks` holds a reserved share and every changed file stays represented — trimmed if need be —
  with source ordered ahead of docs and lockfiles, and each JSON section sheds detail (saying what it
  dropped) instead of being cut mid-structure. 4096 was the old default and was measurably too small: on a
  22-file merge request it returned every section but only 15 of 26 hunk windows and an emptied symbol
  list. Run `repospector-mcp --help` for every flag and its default.

  Flags go in `args` in your client config:

  ```json
  "mcpServers": {
    "repospector": {
      "command": "npx",
      "args": ["-y", "repospector-mcp", "--max-tool-tokens", "24000"]
    }
  }
  ```
- `GITHUB_TOKEN` / `GITLAB_TOKEN` — read from the **environment only, never from a flag**, since anything
  in `args` is visible to any process that can list the process table. Needed only when this server
  fetches a private diff *itself*; passing `diff` avoids them entirely. These are **git-host credentials,
  not model API keys** — this package has no model API key of any kind.

## Caching and disk use

- Each repository's graph and RAG index live in `~/.repospector/index/<hash of its absolute path>/`.
- The local embedding model (`Xenova/all-MiniLM-L6-v2`) is cached once at `~/.repospector/models/`.
- The first run downloads that model (roughly 23 MB) and builds the index from scratch. Every run after
  restores the cached snapshot and re-embeds only files that changed.

Indexes are **not** deleted automatically, and they are not small: expect a couple of megabytes for a
small repository and around 40 MB for one of a few hundred files. Two consequences worth knowing:

- Every repository you point the server at keeps its index indefinitely.
- The cache key is the repository's **absolute path**, so moving or renaming a repository causes a rebuild
  from scratch and leaves the old copy behind.

`index_repo` maintains the cache on request:

```jsonc
{ "prune": true }                    // delete indexes whose repository no longer exists
{ "max_cache_mb": 2000 }             // evict least-recently-used indexes until the cache fits 2 GB
```

`--max-cache-mb <n>` applies the same limit on every build. Neither runs unless asked: evicting a live
repository's index is safe but costs a full re-index on next use. Both refuse to touch the index currently
in use, and `prune` never deletes an index it cannot identify — "cannot identify" is not "orphaned".

Indexes created before version 0.1.1 carry no record of their repository, so `prune` cannot judge them and
leaves them alone; they are labelled the next time their repository is used. To reclaim everything at once:

```bash
rm -rf ~/.repospector/index      # keeps the downloaded model; everything re-indexes on next use
```

Requires Node 20 or newer.

## `review_pr` returns material, not a review

`review_pr` returns **material for a review** — the diff hunks, a rubric, callers and callees of the
touched symbols, comparable code from the repository, coverage of the change, prior findings, deterministic
static-analysis output, and a `provenance` block — rather than generated prose. This package has no LLM
client, so it cannot write review commentary itself; it hands the connected assistant everything needed to
write that review with the client's own model.

Every section says what it describes, because sections that quietly described different code was this
tool's worst failure: it once linted the working tree while the hunks came from a revision range, and
reported findings on code the change deleted. So:

- `provenance` names the reviewed base and head, the worktree, the commit the index was built from, and how
  far that index is from the reviewed base. When `index.stale` is true, the graph and retrieval sections
  describe other code and should be weighed accordingly.
- `static_analysis` reads whole files **at the reviewed revision**, falling back to the patch's own added
  lines — never to the working tree — when no revision resolves locally; `source` says which. It reports
  the `engines` that ran (`regex` is a pattern matcher, not a parser) and lists in `premiseRefuted` any
  finding withheld because the rule's own construct was absent where it fired.
- `graph_context` and `covering_tests` are scoped to the change, including symbols it removes with the
  callers they still have, and test files it deletes. Repo-wide totals are kept as background only.
- A `range` is compared against the **merge base**, so a base branch's own commits are never reported as
  part of the change under review.

That is a deliberate constraint. Generating findings inside the server would need a model, and both ways to
supply one cost more than they return: MCP sampling has uneven support across clients, so the tool would
simply fail in some of them, and an environment-variable API key would put a model client back inside a
package whose entire point is that it has none.

The `dependencies` section (OSV vulnerability lookups) runs only when the change actually touches a
dependency manifest, and says `applicable: false` when it does not — a real answer rather than a missing
one. Its cache is file-backed beside the index. A section that genuinely cannot run is still named in the
output rather than silently omitted, so a reader cannot mistake a missing check for a passing one.

## Releasing an update

Every publish is guarded: `prepublishOnly` rebuilds `dist/index.js` and runs the full test suite, so a
failing build or a failing test aborts the publish rather than shipping.

```bash
cd packages/mcp

npm run release:dry      # inspect the exact tarball without publishing
npm run version:patch    # 0.1.0 -> 0.1.1  (minor / major also available)
npm run release          # builds, tests, then publishes
```

Then commit the version bump yourself. The `version:*` scripts pass
`--no-git-tag-version` deliberately: this package lives in a monorepo whose Chrome extension has its own
version line, so `npm version` must not create `v0.1.x` git tags in that namespace or commit on your
behalf.

Which bump to use:

| | When |
| --- | --- |
| `version:patch` | Bug fixes, documentation, anything that cannot change a tool's inputs or outputs. |
| `version:minor` | A new tool, a new argument, a new flag — additive changes clients can ignore. |
| `version:major` | A renamed or removed tool, a removed argument, a changed response shape. Tool names are a wire contract: a client's saved prompts and any agent instructions reference them by name, so renaming one breaks callers. |

Useful afterwards:

```bash
npm view repospector-mcp versions      # everything published
npm dist-tag ls repospector-mcp        # which version `latest` points at
npm deprecate repospector-mcp@0.1.0 "message"   # warn installers off a bad release
```

A published version can never be reused, even after unpublishing, and unpublishing is only possible within
72 hours. Prefer publishing a fixed version over trying to withdraw a bad one.

Users on `npx -y repospector-mcp` pick up a new release automatically; `npx` caches, so someone testing a
just-published version may need `npx -y repospector-mcp@latest`.

## License

MIT

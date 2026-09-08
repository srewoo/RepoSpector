# Design — RepoSpector MCP server

Date: 2026-09-08
Status: awaiting review (revised 2026-09-08: added `review_pr` and `index_repo`)
Scope: new `packages/mcp` package. No extension changes. Keyless-extension work
is a separate spec — `2026-09-08-keyless-extension-design.md`.

## Why, and what it is not

The question this answers was: can RepoSpector's LLM calls be routed through a
Claude or ChatGPT desktop subscription instead of an API key?

Not directly. MCP clients reach a server over stdio to a local process, or over
HTTP to a remote URL. A Chrome MV3 extension is neither — it cannot listen on a
port, and nothing outside the browser can dial into it. There is also no public
OAuth client registration that would let a third-party app spend a consumer
Claude or ChatGPT subscription; those sign-in flows exist only for first-party
clients, and consumer terms restrict credentials to them.

So we invert the direction. Rather than RepoSpector calling a model, Claude
Desktop, Claude Code and Codex call **RepoSpector** — for repository context.
The user's subscription does the reasoning it is already paying for; RepoSpector
supplies graph traversal and hybrid retrieval, which is the part it is actually
good at and the part a general coding agent lacks.

The consequence worth stating plainly: **this server contains no LLM client and
no key of any kind.** `LLMService.js` is never imported. It is keyless
structurally, not by configuration — there is no code path that could call a
model even if a key were present.

**Not in this spec:** no cloud backend, no LLM client of any kind, no MCP
sampling, no bridge to the extension, no auth, no shared state with the browser.
`review_pr` IS included, but as a context bundle rather than a generated review —
see below. The extension and this server are independent products over shared
analysis code.

---

## Distribution

```jsonc
// Claude Desktop, Claude Code, and Codex all accept this shape
{ "mcpServers": { "repospector": {
    "command": "npx",
    "args": ["-y", "@repospector/mcp", "--repo", "."]
} } }
```

Published to npm as `@repospector/mcp`. `npx -y` means no install step and no
version pinning for the user. Nothing to host, nothing to operate, no per-call
cost to anyone.

---

## Tool surface

Six context primitives. Claude composes them into reviews, explanations and
test plans itself — we do not attempt to own the reasoning.

| Tool | Arguments | Returns | Backed by |
| --- | --- | --- | --- |
| `search_code` | `query`, `k?` | ranked snippets with paths and line spans | `HybridSearcher` (BM25 + HNSW) |
| `get_symbol` | `name`, `kind?` | definition, file, span, docstring, signature | `SymbolExtractor`, `KnowledgeGraphService` |
| `find_callers` | `symbol`, `depth?` | call sites with confidence scores | `CallGraphBuilder` |
| `impact_of_change` | `paths[]` | blast radius, communities, covering tests | `ImpactAnalyzer`, `CommunityDetector`, `TestCoverageBuilder` |
| `get_diff_context` | `pr_url` or `base..head` | hunks plus graph neighbours | `HunkWindower`, `GitHubService`, `GitLabService` |
| `repo_overview` | — | languages, entrypoints, graph stats, index health | `CodeGraphPipeline` |
| `index_repo` | `force?`, `max_files?` | build stats, per-file counts, parser mode | `RAGService`, `CodeGraphPipeline`, `IndexManifest` |
| `review_pr` | `pr_url` or `base..head` | a review **bundle** (see below), not findings | the context services + keyless analyzers |

### `index_repo` — explicit control over indexing

Lazy indexing (below) stays as the fallback, but a first-class tool matters for
two reasons the design originally missed. A user who has just cloned or pulled
wants to index deliberately rather than discovering it as a 60-second pause
inside their first `search_code`. And there is no other way to force a rebuild:
`IndexManifest` hashing means a warm repo reprocesses only changed files, which
is right almost always and wrong exactly when the index is suspected corrupt.

`force: true` discards the manifest and rebuilds from scratch. `max_files`
overrides the `--max-files` ceiling for one call. The result reports what the
build actually did — files parsed, chunks embedded, graph nodes and edges, and
`parser: "tree-sitter" | "regex-fallback"` — so a degraded index is visible at
the moment it is created rather than inferred later from poor results.

### `review_pr` — a bundle, not a verdict

This is the one tool that changed shape from the original design, which excluded
it. It is included now, but it **returns the material for a review rather than
the review itself**:

```
review_pr(pr_url) -> {
  hunks[],            // windowed diff, via HunkWindower
  rubric,             // RepoSpector's review instructions
  graph_context[],    // callers, callees, blast radius for touched symbols
  similar_code[],     // hybrid-retrieved comparable code
  covering_tests[],   // via TestCoverageBuilder
  prior_findings[],   // via PriorFindingService, so repeats are visible
  static_analysis[],  // ESLint / Semgrep / tree-sitter lint / secrets — deterministic
}
```

**Why not the real orchestrator.** `ReviewOrchestrator` needs an LLM callable,
and this package deliberately has none. The two ways to give it one both cost
more than they return: MCP sampling has uneven client support, so `review_pr`
would fail outright in some clients; and an env-var API key would put an LLM
client back inside a package whose entire selling point is that it has none.
Handing Claude the assembled context keeps the keyless invariant exact and works
in every MCP client.

The `static_analysis` block is the part Claude genuinely cannot produce for
itself — real ESLint, Semgrep, tree-sitter lint and secret-scan results over the
changed files, with no model involved. That is the strongest single reason this
tool earns its place.

**Feasibility, checked rather than assumed.** Every service the bundle needs is
already browser-free: `StaticAnalysisService`, `SemgrepAnalyzer`,
`SecretsScanner`, `ESLintAnalyzer`, `ESLintEngine`, `TreeSitterLintEngine`,
`PriorFindingService`, `TestCoverageBuilder`, `HunkWindower`,
`ReviewFileContextService` and `ReviewGraphContextService` contain zero
`chrome.*` references. The one exception is `OSVService`, whose only Chrome
dependency is cache persistence (`chrome.storage.local` at lines 252 and 263);
it needs the same injected-store treatment as Adapter 3, or dependency data is
simply omitted from the bundle in the first version.

### Every response is size-capped

An MCP tool result lands directly in the client's context window. A
`search_code` that helpfully returns forty full files poisons the conversation
it was meant to inform, and the client cannot undo it.

So each tool declares a token ceiling (default 4k, `--max-tool-tokens` to
change), truncates at chunk boundaries rather than mid-line, and states what it
dropped: `"showing 8 of 34 matches (token limit); narrow the query or raise
--max-tool-tokens"`. Being explicit lets Claude decide to re-query; silent
truncation makes it reason confidently from a partial picture, which is the
worse failure.

`get_symbol` returns spans and paths rather than whole files by default. The
client can read the file itself — it has filesystem tools. Duplicating file
contents into tool output wastes the budget on something the caller already has
cheaper access to.

---

## Architecture: three adapters

The port is small because the analysis services are already browser-free.
`CodeGraphPipeline`, `RAGService`, `HybridSearcher`, `BM25Index`, `HNSWIndex`,
`SymbolExtractor`, `CallGraphBuilder`, `ImportGraphService` and
`KnowledgeGraphService` contain **zero** `chrome.*` references. Browser coupling
lives in exactly three places, and each has a clean seam.

### Adapter 1 — Tree-sitter parsing

`CodeGraphPipeline` already takes its parser by injection
(`CodeGraphPipeline.js:41`), and `OffscreenGraphParser.analyzeFiles` returns
`null` when `chrome` is absent (`OffscreenGraphParser.js:29`), degrading to
regex extraction. The seam exists; we fill it rather than fork it.

`NodeTreeSitterParser` implements the same `analyzeFiles(files, onProgress) →
Map` contract over `web-tree-sitter`, which is already a dependency and runs in
Node natively. Grammars come from the `tree-sitter-wasms` package already in
`node_modules` — the extension's build copies them to `dist/assets/grammars/`,
and Node resolves them from the package directly. No new grammar assets, no
vendoring, and grammar coverage stays identical to the extension's by
construction.

Injected as `new CodeGraphPipeline({ offscreenParser: nodeParser })`. A contract
test asserts both implementations satisfy the same shape, so the seam cannot
drift silently.

### Adapter 2 — Embeddings

`RAGService` already supports `provider: 'local'` (`RAGService.js:38`) using
Transformers.js with `Xenova/all-MiniLM-L6-v2` at 384 dimensions. In Node that
is `@huggingface/transformers` with the same model, cached under
`~/.repospector/models` — a one-time ~90 MB download, then offline forever.

Keyless, and identical vectors to the extension's local path, which means an
index built by either side is semantically comparable.

Unlike the parser, this seam does **not** yet exist. `RAGService` hard-constructs
`new OffscreenEmbeddingService()` (`RAGService.js:45`); there is no
`options.embeddingService`. So this adapter requires one additive change to
extension code: accept an injected embedding service, defaulting to today's
construction when none is passed.

That is two lines, it changes no existing behaviour, and it mirrors the pattern
`CodeGraphPipeline` already establishes for its parser (`CodeGraphPipeline.js:41`)
— so it makes the two pipelines consistent rather than introducing a new idiom.
The alternative, aliasing the module at esbuild time, needs no `src/` edit at all
but hides the substitution behind a filename; an explicit injection point is
worth the two lines.

The `gemini` and `openai` embedding providers are deliberately not wired up.
They need keys, and offering them would reintroduce the thing this package
exists to remove.

### Adapter 3 — Persistence

The one genuine decision. In-memory graph state is plain `Map`s
(`KnowledgeGraphService.nodes` / `.relationships`), but persistence is
IndexedDB: `save`/`load` at `KnowledgeGraphService.js:238` and `:275`, and
`VectorStore` through `getDatabase()` (`VectorStore.js:41`, `Database.js:6`).

**Chosen: `fake-indexeddb` plus disk snapshots.** Install the shim as
`globalThis.indexedDB` before any service loads, then snapshot to
`~/.repospector/<repo-hash>/` after each index build and restore on startup.

Why this over the cleaner alternative: extracting a storage-port interface would
touch `KnowledgeGraphService`, `VectorStore`, `HNSWStore`, `BM25Store` and
`ManifestStore` — five files in the shipping extension — to serve a single new
consumer, and every one of those edits is a regression risk to a product
already in the store. The shim requires **zero changes to extension code**,
and needs no `src/` edit at all: installing the shim as a global before any
service loads means `Database.js` runs unchanged against it. If a second
non-browser consumer ever appears, extract the port then; the snapshot format is
internal, so nothing here forecloses it.

The cost, stated honestly: `fake-indexeddb` holds the whole index in memory, so
peak RSS scales with repo size. That is what `--max-files` bounds, and
`repo_overview` reports index size so the limit is visible rather than
mysterious.

### Packaging

`packages/review-core` exists but is not wired in: the root `package.json`
declares no `workspaces`, and nothing yet imports `@repospector/review-core` —
its own header describes itself as day-1 scaffolding. So this package cannot
simply depend on it.

Two steps, in order:

1. Add `"workspaces": ["packages/*", "apps/*"]` to the root `package.json`, so
   local development resolves across packages. This is overdue independently —
   `apps/api` and `packages/review-core` both assume it.
2. `packages/mcp` imports analysis services by relative path into
   `src/services/`, and **bundles them with esbuild at publish time** into
   `packages/mcp/dist/`. A published npm package cannot reach up out of its own
   directory, so the dependency has to be resolved at build time, not install
   time. WASM grammars and the embedding model stay external — resolved from
   `node_modules` and downloaded at first run respectively, never bundled.

---

## Index lifecycle

Lazy by default, explicit when asked. `index_repo` is the deliberate path; otherwise the first tool call triggers a build. The server does not index on
startup, because an MCP client spawns every configured server at launch and a
server that pins a CPU core on boot is a bad citizen.

Builds emit MCP progress notifications so the client shows movement instead of
a silent 60-second stall.

Rebuilds are incremental and already supported: `IndexManifest` hashes file
content and `GraphAnalysisCache` caches per-file tree-sitter analyses, so a warm
repo re-processes only what changed. This is the same machinery the extension
uses for incremental review.

Files come from the local git worktree — `--repo`, defaulting to `cwd`, and
honouring MCP roots when the client sends them. `.gitignore` is respected;
binary and generated paths are skipped by the existing filters.

`get_diff_context` is the only tool that touches the network, via the existing
`GitHubService` / `GitLabService`. It reads `GITHUB_TOKEN` / `GITLAB_TOKEN` from
the environment when present, for private repos and rate limits. Absent, public
repos still work. This is a git-host credential, not a model key — the keyless
property is unaffected.

---

## Error handling

Every tool returns a structured MCP error rather than throwing. Each error tells
the client how to recover, because the client is a model that can act on the
advice:

| Condition | Response |
| --- | --- |
| No index yet | build automatically; if it fails, name the reason |
| Symbol not found | fuzzy near-misses, so Claude can retry with a correct name |
| Repo exceeds `--max-files` | the count, the ceiling, and the flag to raise it |
| Grammar missing for a language | which languages are covered; the file is regex-parsed |
| Network failure in `get_diff_context` | the host and status; other tools stay usable |

Tree-sitter failure degrades to regex extraction — the extension's existing
behaviour — but `repo_overview` reports `parser: "regex-fallback"` so degraded
precision is legible. A silently degraded index that looks healthy is how a
caller comes to trust a weak result.

---

## Testing

`node --test`, matching `apps/api` rather than the extension's Jest and
CommonJS-in-`test/` arrangement. This package is Node-native ESM and should not
inherit the browser test setup.

Four layers:

1. **Adapter units** — `NodeTreeSitterParser` over fixture sources for each
   grammar; the Node embedder's dimensionality and determinism; snapshot
   round-trip through the persistence shim, asserting a restored index answers
   queries identically to the one that built it.
2. **Parser contract** — one shared suite run against both
   `OffscreenGraphParser` and `NodeTreeSitterParser`, asserting the same
   `analyzeFiles` shape. This is what keeps the injected seam honest.
3. **Tool goldens** — all six tools against a small committed fixture repo with
   known symbols, imports and call edges. Asserts ranked output is stable and
   that the token cap truncates at chunk boundaries with an accurate dropped
   count.
4. **stdio integration** — drive the server over real MCP framing: initialize,
   `tools/list`, call each tool, assert well-formed results. A server that
   passes unit tests and fails the handshake is the classic MCP failure, and
   only an end-to-end transport test catches it.

Manual verification against all three clients — Claude Desktop, Claude Code,
Codex — since config discovery and roots behaviour differ between them and none
of that is unit-testable.

## Success criteria

- Configured in Claude Desktop with `npx -y @repospector/mcp`, all eight tools
  answer against a real repository, with no key configured anywhere.
- A cold index on a mid-size repo completes with visible progress; a warm
  re-index processes only changed files.
- The only change under `src/` is the additive embedding-service injection point
  in `RAGService` (Adapter 2). No existing behaviour changes; the extension's
  full test suite passes untouched.
- `grep -r LLMService packages/mcp` returns nothing.

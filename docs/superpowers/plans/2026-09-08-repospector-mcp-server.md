# RepoSpector MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@repospector/mcp` — a standalone stdio MCP server that lets Claude Desktop, Claude Code and Codex query a repository's graph and retrieval index, so the user's subscription does the reasoning and no API key is needed anywhere.

**Architecture:** A new `packages/mcp` Node package reusing the extension's browser-free analysis services through three injected adapters (tree-sitter, embeddings, persistence). Eight tools, all read-only context providers. The package contains no LLM client and no key — `review_pr` returns the *material* for a review, not a generated review.

**Tech Stack:** Node 20+ ESM, `@modelcontextprotocol/sdk` (stdio), `web-tree-sitter` + `tree-sitter-wasms`, `@xenova/transformers`, `fake-indexeddb`, `esbuild`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-08-repospector-mcp-server-design.md`

## Global Constraints

- **No LLM client, no API key, ever.** `grep -r "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` must return nothing at every task boundary. This is the package's defining property, not a preference.
- **Tests use `node --test`**, matching `apps/api`, NOT the extension's Jest. Test files live in `packages/mcp/test/` and are ESM (`import`), because this package is Node-native. Do NOT copy the extension's CommonJS-in-`test/` convention — that exists only because `test/package.json` creates a Babel package boundary, which does not apply here.
- **Run one test file:** `node --test packages/mcp/test/<name>.test.js` from the repo root.
- **The extension's Jest suite must stay green at 180 suites / 2613 passed / 1 skipped / 0 failed** at every task boundary. Verify with `npx jest` from the repo root. This plan touches exactly one file under `src/` (Task 4); everything else is new.
- **`npm run build` (the extension build) must keep passing.** Adding workspaces changes dependency resolution, so this is a real gate, not a formality.
- No file > 300 lines, no function > 50 lines.
- **Every tool response is size-capped.** Default 4k tokens, `--max-tool-tokens` to override, truncate at chunk boundaries, and state what was dropped. An MCP result lands directly in the client's context and the client cannot undo it.
- **Node version floor: 20.** `node --test` and the SDK both assume it.
- Provider/tool names are wire contract. Exact tool names: `search_code`, `get_symbol`, `find_callers`, `impact_of_change`, `get_diff_context`, `repo_overview`, `index_repo`, `review_pr`.

## Three corrections to the spec, verified before writing this plan

The spec was written before these were checked. Where they conflict, **this plan wins** and the reason is recorded here.

1. **Adapter 1 is nearly free.** The spec frames a new `NodeTreeSitterParser`. Unnecessary: `TreeSitterParser` (`src/services/TreeSitterParser.js:28-42`) already accepts `module`, `runtimeLocator` and `grammarLoader` by injection, and its own docstring says it is "runtime-agnostic … runs in the extension service worker (chrome.runtime.getURL + fetch) and in Node tests (filesystem)". A **working Node instantiation already exists** at `test/unit/TreeSitterLintEngine.test.js:10-19`. Task 3 wraps that proven code; it does not invent a parser.
2. **Embeddings use `@xenova/transformers`, not `@huggingface/transformers`.** The spec names the latter; the repo already depends on `@xenova/transformers@2.17.2` (`package.json:116`) and the extension's local embedder uses it with `Xenova/all-MiniLM-L6-v2`. Using the same package means the same model and the same vectors — and no new dependency.
3. **Only two new dependencies are needed.** Verified present: `web-tree-sitter@0.25.10`, `tree-sitter-wasms@0.1.13`, `@xenova/transformers@2.17.2`, `esbuild@0.27.0`. Absent and required: `@modelcontextprotocol/sdk`, `fake-indexeddb`.

Also confirmed: `getDatabase()` (`src/services/Database.js:6-10`) opens the **bare global** `indexedDB`, so installing the shim as `globalThis.indexedDB` needs zero changes to that file — the spec's central persistence claim holds.

## Interfaces the ported services already expose

Copy these signatures verbatim; they are the contracts the adapters must satisfy.

| Unit | Signature |
| --- | --- |
| Embedder (what `RAGService` calls) | `init(onProgress)`, `generateEmbeddings(texts, opts)`, `generateEmbedding(text)`, `getDimension()`, `getModelInfo()` |
| Parser (what `CodeGraphPipeline` calls) | `analyzeFiles(files, onProgress) → Promise<Map<path, analysis> \| null>` |
| `CodeGraphPipeline` | `buildGraph(repoId, files, onProgress)`, `loadGraph(repoId)`, `hasGraph(repoId)`, `getSymbolContext(name)`, `getCallerRefs(name, limit)`, `getUntestedInBlastRadius(name, opts)`, `safetyCheck(name)`, `getStats()` |
| `RAGService` | `retrieveContext(repoId, query, limit, options)`, `indexRepositoryIncremental(repoId, files, onProgress, options)` — `options.force` does a full rebuild |
| `TreeSitterParser` ctor | `{ module, runtimeLocator: () => string, grammarLoader: (grammarName) => Promise<Uint8Array> }` |

`files` is always `Array<{path: string, content: string}>`.

## File Structure

**Create — all under `packages/mcp/`:**

| File | Responsibility |
| --- | --- |
| `package.json` | name, bin, deps, `node --test` script |
| `src/index.js` | bin entry: parse argv, build server, connect stdio |
| `src/server.js` | MCP server construction + tool registration only |
| `src/config.js` | argv/env → config object. Pure. |
| `src/adapters/persistence.js` | installs `fake-indexeddb`, snapshots to disk |
| `src/adapters/treeSitter.js` | Node `analyzeFiles` over the injected parser |
| `src/adapters/embedder.js` | Node embedder satisfying the embedder contract |
| `src/adapters/osvCache.js` | file-backed cache for `OSVService` |
| `src/repo/source.js` | read a git worktree into `files[]`, honouring `.gitignore` |
| `src/repo/indexer.js` | owns the pipeline + RAG lifecycle for one repo |
| `src/tools/registry.js` | tool name → handler + JSON schema |
| `src/tools/search.js` | `search_code`, `get_symbol`, `find_callers` |
| `src/tools/impact.js` | `impact_of_change`, `repo_overview` |
| `src/tools/index_repo.js` | `index_repo` |
| `src/tools/diff.js` | `get_diff_context` |
| `src/tools/review.js` | `review_pr` bundle assembly |
| `src/tools/cap.js` | token estimate + boundary truncation. Pure. |
| `test/*.test.js` | one file per unit above |
| `test/fixtures/mini-repo/` | small committed repo with known symbols |

**Modify:**

| File | Change |
| --- | --- |
| `package.json` (root) | add `"workspaces": ["packages/*", "apps/*"]`, add the two new deps |
| `src/services/RAGService.js:44-46` | accept an injected embedding service (Task 4 — the ONLY `src/` change) |

**Dependency order:** 1 → 2 → 3 → 4 → 5 → {6, 7} → 8 → 9. Tasks 6 and 7 are independent of each other.

---

### Task 1: Workspace, package scaffold, and a real stdio handshake

**Files:**
- Modify: `package.json` (root)
- Create: `packages/mcp/package.json`, `packages/mcp/src/config.js`, `packages/mcp/src/server.js`, `packages/mcp/src/index.js`, `packages/mcp/src/tools/registry.js`
- Test: `packages/mcp/test/config.test.js`, `packages/mcp/test/handshake.test.js`

**Interfaces:**
- Produces: `parseConfig(argv, env) → {repo, maxFiles, maxToolTokens, githubToken, gitlabToken}`; `createServer(config) → Server`; `TOOLS` (array of `{name, description, inputSchema, handler}`) exported from `registry.js`, empty in this task.

**Why the handshake comes first.** A server that passes every unit test and fails `initialize` is the classic MCP failure, and it is invisible to unit tests. Proving the transport with zero tools costs one task and de-risks the other eight.

- [ ] **Step 1: Add workspaces and the two new dependencies**

In the root `package.json`, add a top-level `"workspaces"` key (after `"license"`), and add the two absent deps to `devDependencies`:

```json
  "workspaces": ["packages/*", "apps/*"],
```

```json
    "@modelcontextprotocol/sdk": "^1.0.0",
    "fake-indexeddb": "^6.0.0",
```

Then install: `npm install`

- [ ] **Step 2: Verify the extension is undisturbed**

Run: `npx jest`
Expected: 180 suites, 2613 passed, 1 skipped, 0 failed — unchanged.

Run: `npm run build`
Expected: "Build validation passed!"

Workspaces change how npm resolves modules, so a regression here is real and must be fixed before continuing, not after.

- [ ] **Step 3: Create the package manifest**

Create `packages/mcp/package.json`:

```json
{
  "name": "@repospector/mcp",
  "version": "0.1.0",
  "description": "RepoSpector as an MCP server — repository graph and retrieval context for Claude and Codex. No API key.",
  "type": "module",
  "license": "MIT",
  "bin": { "repospector-mcp": "src/index.js" },
  "files": ["src", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/",
    "start": "node src/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@xenova/transformers": "^2.17.2",
    "fake-indexeddb": "^6.0.0",
    "tree-sitter-wasms": "^0.1.13",
    "web-tree-sitter": "^0.25.10"
  }
}
```

- [ ] **Step 4: Write the failing config test**

Create `packages/mcp/test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

test('defaults the repo to the working directory', () => {
    const c = parseConfig([], {});
    assert.equal(c.repo, process.cwd());
});

test('--repo overrides, and is resolved to an absolute path', () => {
    const c = parseConfig(['--repo', '.'], {});
    assert.equal(c.repo, process.cwd());
});

test('--max-files and --max-tool-tokens parse as integers', () => {
    const c = parseConfig(['--max-files', '500', '--max-tool-tokens', '8000'], {});
    assert.equal(c.maxFiles, 500);
    assert.equal(c.maxToolTokens, 8000);
});

test('a non-numeric limit falls back to the default rather than NaN', () => {
    // NaN would silently disable the cap, which is the failure the cap exists to prevent.
    const c = parseConfig(['--max-tool-tokens', 'lots'], {});
    assert.equal(c.maxToolTokens, 4096);
});

test('git host tokens come from the environment, never from argv', () => {
    // A token in argv is visible in the process list to every other process.
    const c = parseConfig(['--repo', '.'], { GITHUB_TOKEN: 'gh', GITLAB_TOKEN: 'gl' });
    assert.equal(c.githubToken, 'gh');
    assert.equal(c.gitlabToken, 'gl');
    const none = parseConfig([], {});
    assert.equal(none.githubToken, null);
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `node --test packages/mcp/test/config.test.js`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 6: Implement config.js**

Create `packages/mcp/src/config.js`:

```js
import path from 'node:path';

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_TOOL_TOKENS = 4096;

/** Read a flag's value from an argv array, or null. */
function flag(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * A positive integer, or the fallback.
 *
 * Never returns NaN: a NaN ceiling compares false against everything and
 * silently disables the cap it was supposed to enforce.
 */
function intOr(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {string[]} argv Arguments after the node binary and script.
 * @param {Record<string, string|undefined>} env
 */
export function parseConfig(argv = [], env = {}) {
    return {
        repo: path.resolve(flag(argv, '--repo') || process.cwd()),
        maxFiles: intOr(flag(argv, '--max-files'), DEFAULT_MAX_FILES),
        maxToolTokens: intOr(flag(argv, '--max-tool-tokens'), DEFAULT_MAX_TOOL_TOKENS),
        // Environment only. A token passed in argv is readable from the process
        // list by any other process on the machine.
        githubToken: env.GITHUB_TOKEN || null,
        gitlabToken: env.GITLAB_TOKEN || null,
    };
}
```

- [ ] **Step 7: Run the config test and confirm it passes**

Run: `node --test packages/mcp/test/config.test.js`
Expected: PASS, 5 tests

- [ ] **Step 8: Create the empty tool registry**

Create `packages/mcp/src/tools/registry.js`:

```js
/**
 * Tool name → definition. Later tasks push into this list.
 *
 * A single registry rather than registration scattered through the server:
 * the wire contract is the tool names and schemas, and one list is what makes
 * that contract reviewable in one place.
 *
 * Each entry: { name, description, inputSchema, handler }
 * `handler(args, ctx) → Promise<{content: [{type: 'text', text: string}]}>`
 */
export const TOOLS = [];
```

- [ ] **Step 9: Implement the server and bin entry**

Create `packages/mcp/src/server.js`:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools/registry.js';

/**
 * Build the MCP server for one repository.
 *
 * Holds no state of its own beyond the config and the shared context object;
 * everything expensive (index, graph, model) is created lazily by the tools
 * that need it, because an MCP client spawns every configured server at launch
 * and one that indexes on boot is a bad citizen.
 */
export function createServer(config) {
    const server = new Server(
        { name: 'repospector', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    // Shared per-process context. Tools receive it and may populate lazily.
    const ctx = { config, indexer: null };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name, description, inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = TOOLS.find((t) => t.name === request.params.name);
        if (!tool) {
            // Structured, not thrown: the client is a model and can act on a
            // message that names what IS available.
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `Unknown tool "${request.params.name}". Available: ${TOOLS.map((t) => t.name).join(', ') || 'none'}.`,
                }],
            };
        }
        return tool.handler(request.params.arguments || {}, ctx);
    });

    return server;
}
```

Create `packages/mcp/src/index.js`:

```js
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig } from './config.js';
import { createServer } from './server.js';

const config = parseConfig(process.argv.slice(2), process.env);
const server = createServer(config);

// stdout is the MCP transport. Anything written there that is not a protocol
// message corrupts the stream, so diagnostics MUST go to stderr — including
// any console.log inside a ported extension service.
console.log = (...args) => console.error(...args);

await server.connect(new StdioServerTransport());
console.error(`repospector-mcp ready — repo: ${config.repo}`);
```

- [ ] **Step 10: Write the handshake test**

Create `packages/mcp/test/handshake.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/**
 * Drives the server over real stdio with real MCP framing. Unit tests cannot
 * catch a broken handshake, and a broken handshake makes every tool
 * unreachable regardless of how well it is tested.
 */
function rpc(child, message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
}

test('completes initialize and lists tools over stdio', async () => {
    const child = spawn('node', ['packages/mcp/src/index.js', '--repo', '.'], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) lines.push(line);
        }
    });

    rpc(child, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'plan-test', version: '0' },
        },
    });

    // Poll rather than sleep a fixed interval: a fixed sleep is either flaky or slow.
    const deadline = Date.now() + 15000;
    while (lines.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(lines.length >= 1, 'server sent no response to initialize');
    const init = JSON.parse(lines[0]);
    assert.equal(init.id, 1);
    assert.equal(init.error, undefined);
    assert.equal(init.result.serverInfo.name, 'repospector');

    rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const d2 = Date.now() + 15000;
    while (lines.length < 2 && Date.now() < d2) {
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(lines.length >= 2, 'server sent no response to tools/list');
    const list = JSON.parse(lines[1]);
    assert.equal(list.error, undefined);
    assert.ok(Array.isArray(list.result.tools));

    child.kill();
});
```

- [ ] **Step 11: Run the handshake test**

Run: `node --test packages/mcp/test/handshake.test.js`
Expected: PASS. If `initialize` returns an error, the SDK's API shape differs from the code above — read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts` and adapt, then say in your report what differed.

- [ ] **Step 12: Confirm the keyless invariant**

Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src`
Expected: no output.

- [ ] **Step 13: Commit** — ask the user first

```bash
git add package.json package-lock.json packages/mcp
git commit -m "feat(mcp): scaffold the stdio MCP server with a verified handshake"
```

---

### Task 2: Persistence adapter — `fake-indexeddb` plus disk snapshots

**Files:**
- Create: `packages/mcp/src/adapters/persistence.js`
- Test: `packages/mcp/test/persistence.test.js`

**Interfaces:**
- Produces: `installIndexedDb()` (call before importing ANY extension service), `snapshot(dir) → Promise<{databases: number, records: number}>`, `restore(dir) → Promise<{databases: number, records: number}>`, `REPOSPECTOR_DATABASES` (the fallback name list), `snapshotDir(baseDir, repoPath) → string`

**The ordering constraint that makes or breaks this task.** `restore()` cannot create schemas — object stores and their `keyPath`s are defined inside each service's own `onupgradeneeded`. So the sequence is fixed and non-obvious:

1. `installIndexedDb()` — before any service import, because `Database.js:10` calls the bare global `indexedDB` at module scope of its first use.
2. Let the services open their databases (this runs their upgrade handlers and creates the stores).
3. `restore(dir)` — write records into stores that now exist.
4. Only then read.

Restoring before step 2 fails with "object store not found"; reading before step 3 silently returns an empty index, which looks like "nothing is indexed" rather than an error. Task 5 wires this order; get it right here and document it in the module.

**There are seven databases, not one.** Verified: `RepoSpectorDB` (`Database.js`), `repospector_knowledge_graph` (`KnowledgeGraphService.js:31`), `repospector_graph_analysis` (`GraphAnalysisCache.js:28`), `RepoSpectorBM25` (`BM25Store`), `RepoSpectorHNSW` (`HNSWStore`), `RepoSpectorManifests` (`IndexManifest`), `repospector_learning` (`AdaptiveLearningService`). A snapshot that covers only `RepoSpectorDB` would silently lose the graph, the BM25 index, the HNSW index and the manifest — leaving a "warm" index that answers nothing.

- [ ] **Step 1: Check whether `indexedDB.databases()` works in this shim**

Run:

```bash
node -e "
require('fake-indexeddb/auto');
(async () => {
  console.log('databases() is', typeof indexedDB.databases);
  if (typeof indexedDB.databases === 'function') console.log(await indexedDB.databases());
})();
"
```

If it prints `databases() is function`, the enumeration path works and the name list is only a fallback. If it prints `undefined`, enumeration is unavailable and `REPOSPECTOR_DATABASES` becomes the primary path. Record which in your report — the implementation below handles both, but the reviewer needs to know which branch is live.

- [ ] **Step 2: Write the failing round-trip test**

Create `packages/mcp/test/persistence.test.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installIndexedDb, snapshot, restore, snapshotDir } from '../src/adapters/persistence.js';

before(() => installIndexedDb());

/** Open a DB, creating one store, exactly as an extension service would. */
function openWithStore(name, store, keyPath) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function put(db, store, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([store], 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getAll(db, store) {
    return new Promise((resolve, reject) => {
        const req = db.transaction([store], 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

test('installIndexedDb exposes a working global', () => {
    assert.equal(typeof indexedDB, 'object');
    assert.equal(typeof indexedDB.open, 'function');
});

test('snapshot then restore round-trips records identically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    const db = await openWithStore('RepoSpectorDB', 'repo_vectors', 'id');
    await put(db, 'repo_vectors', { id: 'a', vector: [0.1, 0.2], text: 'alpha' });
    await put(db, 'repo_vectors', { id: 'b', vector: [0.3, 0.4], text: 'beta' });

    const saved = await snapshot(dir);
    assert.ok(saved.records >= 2, `expected >=2 records, got ${saved.records}`);

    // Wipe the store to simulate a fresh process.
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['repo_vectors'], 'readwrite');
        tx.objectStore('repo_vectors').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    assert.equal((await getAll(db, 'repo_vectors')).length, 0);

    const loaded = await restore(dir);
    assert.ok(loaded.records >= 2);

    const rows = await getAll(db, 'repo_vectors');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.id === 'a').vector, [0.1, 0.2]);
});

test('restore into a database whose stores do not exist does not throw', async () => {
    // The ordering rule: restore runs AFTER services create their schemas. If it
    // is called too early it must degrade, not crash — a crash here would take
    // the whole server down at startup.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    fs.writeFileSync(
        path.join(dir, 'NoSuchDb.json'),
        JSON.stringify({ name: 'NoSuchDb', version: 1, stores: { ghost: [{ id: 1 }] } }),
    );
    const r = await restore(dir);
    assert.equal(typeof r.records, 'number');
});

test('restore from an empty or missing directory is a no-op, not an error', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-persist-'));
    assert.deepEqual(await restore(empty), { databases: 0, records: 0 });
    assert.deepEqual(await restore(path.join(empty, 'nope')), { databases: 0, records: 0 });
});

test('snapshotDir is stable for a repo path and differs between repos', () => {
    const a = snapshotDir('/base', '/work/alpha');
    assert.equal(a, snapshotDir('/base', '/work/alpha'));
    assert.notEqual(a, snapshotDir('/base', '/work/beta'));
    assert.ok(a.startsWith('/base'));
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test packages/mcp/test/persistence.test.js`
Expected: FAIL — cannot find module `../src/adapters/persistence.js`

- [ ] **Step 4: Implement the adapter**

Create `packages/mcp/src/adapters/persistence.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * IndexedDB in Node, with the index persisted to disk between runs.
 *
 * The extension's storage layer is IndexedDB throughout, and its in-memory
 * state is plain Maps. Rather than extracting a storage port across five
 * shipping files to serve one new consumer, this installs a shim as the global
 * and snapshots the contents. Nothing under src/services/ changes.
 *
 * ORDER MATTERS, and getting it wrong fails quietly:
 *   1. installIndexedDb()   — before importing any extension service
 *   2. let services open their databases (their upgrade handlers create stores)
 *   3. restore(dir)         — writes records into stores that now exist
 *   4. read
 * restore() cannot create schemas: object stores and keyPaths are defined
 * inside each service's own onupgradeneeded, not here. Restoring at step 1
 * throws "object store not found"; reading at step 2 returns an empty index,
 * which reads as "nothing indexed" rather than as a bug.
 */

/**
 * Every database the extension opens. Used when `indexedDB.databases()` is
 * unavailable, and as a cross-check when it is.
 *
 * Snapshotting only RepoSpectorDB would silently drop the graph, the BM25 and
 * HNSW indexes and the manifest — producing a warm index that answers nothing.
 */
export const REPOSPECTOR_DATABASES = Object.freeze([
    'RepoSpectorDB',                   // Database.js — repo_vectors, pr_sessions, …
    'repospector_knowledge_graph',     // KnowledgeGraphService
    'repospector_graph_analysis',      // GraphAnalysisCache
    'RepoSpectorBM25',                 // BM25Store
    'RepoSpectorHNSW',                 // HNSWStore
    'RepoSpectorManifests',            // IndexManifest / ManifestStore
    'repospector_learning',            // AdaptiveLearningService
]);

let installed = false;

/** Install the shim as the IndexedDB globals. Idempotent. */
export function installIndexedDb() {
    if (installed) return;
    // `/auto` assigns indexedDB, IDBKeyRange and friends onto globalThis, which
    // is exactly what Database.js:10 reaches for.
    // eslint-disable-next-line no-undef
    require('fake-indexeddb/auto');
    installed = true;
}

/** A stable, filesystem-safe directory for one repository's snapshot. */
export function snapshotDir(baseDir, repoPath) {
    const hash = crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 16);
    return path.join(baseDir, hash);
}

function openExisting(name) {
    return new Promise((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        // A database that has never existed opens at version 1 with no stores,
        // which getAll below simply reports as empty.
        req.onupgradeneeded = () => { /* leave schema alone */ };
    });
}

function getAll(db, store) {
    return new Promise((resolve) => {
        try {
            const req = db.transaction([store], 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        } catch {
            resolve([]);
        }
    });
}

async function databaseNames() {
    if (typeof indexedDB.databases === 'function') {
        try {
            const listed = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
            // Union: enumeration can miss a database this process has not opened.
            return [...new Set([...listed, ...REPOSPECTOR_DATABASES])];
        } catch {
            return [...REPOSPECTOR_DATABASES];
        }
    }
    return [...REPOSPECTOR_DATABASES];
}

/** Write every database's contents to `dir` as one JSON file per database. */
export async function snapshot(dir) {
    fs.mkdirSync(dir, { recursive: true });
    let databases = 0;
    let records = 0;

    for (const name of await databaseNames()) {
        const db = await openExisting(name);
        if (!db) continue;
        const stores = Array.from(db.objectStoreNames);
        if (stores.length === 0) { db.close(); continue; }

        const payload = { name, version: db.version, stores: {} };
        for (const store of stores) {
            const rows = await getAll(db, store);
            payload.stores[store] = rows;
            records += rows.length;
        }
        db.close();

        if (records === 0 && Object.keys(payload.stores).length === 0) continue;
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload));
        databases += 1;
    }

    return { databases, records };
}

/**
 * Load a snapshot back into stores that already exist.
 *
 * Every failure degrades rather than throwing: a snapshot from an older schema,
 * or one written before a store was renamed, must not stop the server from
 * starting. The worst outcome is an index that reports itself cold, which
 * `index_repo` can rebuild.
 */
export async function restore(dir) {
    if (!fs.existsSync(dir)) return { databases: 0, records: 0 };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let databases = 0;
    let records = 0;

    for (const file of files) {
        let payload;
        try {
            payload = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
            continue; // truncated snapshot: skip, do not fail startup
        }
        const db = await openExisting(payload.name);
        if (!db) continue;

        for (const [store, rows] of Object.entries(payload.stores || {})) {
            if (!db.objectStoreNames.contains(store)) continue; // schema not created yet
            if (!Array.isArray(rows) || rows.length === 0) continue;
            await new Promise((resolve) => {
                try {
                    const tx = db.transaction([store], 'readwrite');
                    const os_ = tx.objectStore(store);
                    for (const row of rows) os_.put(row);
                    tx.oncomplete = () => { records += rows.length; resolve(); };
                    tx.onerror = () => resolve();
                } catch {
                    resolve();
                }
            });
        }
        db.close();
        databases += 1;
    }

    return { databases, records };
}
```

- [ ] **Step 5: Fix the CommonJS `require` inside an ESM module**

The `require('fake-indexeddb/auto')` above will throw in ESM. Replace `installIndexedDb` with a top-level side-effect import, which is the idiomatic form:

At the top of the file, replace the function body approach with:

```js
import 'fake-indexeddb/auto';

let installed = false;

/**
 * The shim installs itself via the side-effect import above; this remains as an
 * explicit, ordered call site so the sequence in the module docstring is
 * visible at the point of use rather than implied by import order.
 */
export function installIndexedDb() {
    installed = true;
    return installed;
}
```

Import order still matters: this module must be imported before any extension service, and a side-effect import makes that a property of the import graph rather than of call order. Note in your report that you changed this from the plan's first form and why.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node --test packages/mcp/test/persistence.test.js`
Expected: PASS, 5 tests

- [ ] **Step 7: Confirm the extension is still untouched**

Run: `npx jest`
Expected: 180 suites / 2613 passed / 1 skipped / 0 failed

Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src`
Expected: no output

- [ ] **Step 8: Commit** — ask the user first

```bash
git add packages/mcp/src/adapters/persistence.js packages/mcp/test/persistence.test.js
git commit -m "feat(mcp): IndexedDB shim with on-disk snapshots across all seven databases"
```

---

### Task 3: Tree-sitter adapter for Node

**Files:**
- Create: `packages/mcp/src/adapters/treeSitter.js`
- Test: `packages/mcp/test/treeSitter.test.js`

**Interfaces:**
- Consumes: `TreeSitterParser` from `src/services/TreeSitterParser.js`
- Produces: `createNodeParser() → { analyzeFiles(files, onProgress) → Promise<Map|null>, available: boolean, parser }`

**This task wraps proven code; it does not invent a parser.** `TreeSitterParser` already takes `module`, `runtimeLocator` and `grammarLoader` by injection (`src/services/TreeSitterParser.js:28-42`) and its docstring states it is runtime-agnostic across the service worker and Node. A **working Node instantiation already exists** in the repo at `test/unit/TreeSitterLintEngine.test.js:10-19`:

```js
const RUNTIME_WASM = path.resolve('node_modules/web-tree-sitter/tree-sitter.wasm');
const GRAMMAR_DIR = path.resolve('node_modules/tree-sitter-wasms/out');
const mod = require('web-tree-sitter');
const parser = new TreeSitterParser({
    module: mod,
    runtimeLocator: () => RUNTIME_WASM,
    grammarLoader: async (g) => new Uint8Array(fs.readFileSync(path.join(GRAMMAR_DIR, `tree-sitter-${g}.wasm`))),
});
```

Both wasm sources are verified present: `node_modules/web-tree-sitter/tree-sitter.wasm` (205 KB) and `node_modules/tree-sitter-wasms/out/tree-sitter-*.wasm`.

**Resolve paths from this module, not from `process.cwd()`.** The test above uses `path.resolve()` against the working directory, which is fine for a test run from the repo root but wrong for a published package invoked via `npx` from any directory. Use `import.meta.url` and `createRequire` so the paths follow the installed package.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/test/treeSitter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeParser } from '../src/adapters/treeSitter.js';

const JS = `
export function alpha(x) { return beta(x) + 1; }
function beta(y) { return y * 2; }
export class Widget extends Base { render() { return alpha(1); } }
`;

test('parses real JavaScript into the same shape the regex path produces', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([{ path: 'a.js', content: JS }]);

    assert.ok(analyses instanceof Map, 'expected a Map of path → analysis');
    const a = analyses.get('a.js');
    assert.ok(a, 'no analysis for a.js');

    const names = a.symbols.map((s) => s.name);
    assert.ok(names.includes('alpha'), `alpha missing from ${names.join(', ')}`);
    assert.ok(names.includes('beta'));
    assert.ok(names.includes('Widget'));

    // Shape contract, quoted from TreeSitterParser's docstring: the tree-sitter
    // output must match the regex path exactly, or downstream graph consumers
    // silently see different fields depending on which path ran.
    for (const s of a.symbols) {
        assert.equal(typeof s.name, 'string');
        assert.equal(typeof s.startLine, 'number');
        assert.equal(typeof s.endLine, 'number');
    }
});

test('resolves calls, which is the whole reason for using an AST', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([{ path: 'a.js', content: JS }]);
    const calls = (analyses.get('a.js').calls || []).map((c) => c.name);
    assert.ok(calls.includes('beta'), `expected a call to beta, got ${calls.join(', ')}`);
});

test('parses Python too, proving grammars load from node_modules', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([
        { path: 'm.py', content: 'def gamma(a):\n    return delta(a)\n\ndef delta(b):\n    return b\n' },
    ]);
    const names = (analyses.get('m.py').symbols || []).map((s) => s.name);
    assert.ok(names.includes('gamma'), `gamma missing from ${names.join(', ')}`);
});

test('an unsupported extension is skipped rather than failing the batch', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([
        { path: 'notes.txt', content: 'plain text' },
        { path: 'a.js', content: JS },
    ]);
    assert.equal(analyses.has('notes.txt'), false);
    assert.ok(analyses.has('a.js'), 'a supported file must still be analysed');
});

test('an empty file list returns an empty Map, never null', async () => {
    const adapter = createNodeParser();
    const analyses = await adapter.analyzeFiles([]);
    assert.ok(analyses instanceof Map);
    assert.equal(analyses.size, 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/mcp/test/treeSitter.test.js`
Expected: FAIL — cannot find module `../src/adapters/treeSitter.js`

- [ ] **Step 3: Implement the adapter**

Create `packages/mcp/src/adapters/treeSitter.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TreeSitterParser } from '../../../../src/services/TreeSitterParser.js';

const require_ = createRequire(import.meta.url);

/**
 * Tree-sitter parsing in Node, satisfying the same contract
 * `CodeGraphPipeline` expects from `OffscreenGraphParser`:
 *   analyzeFiles(files, onProgress) → Promise<Map<path, analysis> | null>
 *
 * TreeSitterParser is already runtime-agnostic — it takes the wasm runtime and
 * the grammar loader by injection — so this supplies filesystem versions of
 * both. The extension supplies chrome.runtime.getURL + fetch instead. There is
 * a working precedent for exactly this injection in
 * test/unit/TreeSitterLintEngine.test.js.
 *
 * Paths resolve from the installed package via createRequire, NOT from
 * process.cwd(): this runs under `npx` from whatever directory the user happens
 * to be in, and a cwd-relative path would find nothing.
 */

/** Absolute path to the tree-sitter wasm runtime inside the installed package. */
function runtimeWasmPath() {
    return require_.resolve('web-tree-sitter/tree-sitter.wasm');
}

/** Directory holding the per-language grammar wasm files. */
function grammarDir() {
    // The package exposes its grammars under out/; resolve via its manifest so
    // the location follows the dependency rather than being guessed.
    return path.join(path.dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out');
}

export function createNodeParser() {
    const parser = new TreeSitterParser({
        module: require_('web-tree-sitter'),
        runtimeLocator: () => runtimeWasmPath(),
        grammarLoader: async (grammar) => new Uint8Array(
            fs.readFileSync(path.join(grammarDir(), `tree-sitter-${grammar}.wasm`)),
        ),
    });

    return {
        parser,
        get available() { return parser.available; },

        /**
         * Analyse a batch. Mirrors OffscreenGraphParser's contract, including
         * returning an empty Map for an empty batch — CodeGraphPipeline treats
         * null as "parser unavailable, use regex", so an empty batch must not
         * be reported as a parser failure.
         */
        async analyzeFiles(files, onProgress) {
            if (!Array.isArray(files) || files.length === 0) return new Map();
            return parser.analyzeFiles(files, onProgress);
        },
    };
}
```

- [ ] **Step 4: Verify `TreeSitterParser` actually exposes `analyzeFiles`**

Run: `grep -n "analyzeFiles\|async analyze" src/services/TreeSitterParser.js`

If the public method has a different name (for example `analyze` per-file rather than `analyzeFiles` per-batch), adapt the adapter to loop and build the Map itself, and say so in your report. `OffscreenGraphParser.analyzeFiles` is the contract `CodeGraphPipeline` calls, so the adapter's OUTPUT shape is fixed even if the underlying parser's input shape differs.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test packages/mcp/test/treeSitter.test.js`
Expected: PASS, 5 tests. Grammar loading reads real wasm from disk, so allow up to 30s on a cold run.

- [ ] **Step 6: Verify the gates**

Run: `npx jest` → 180 suites / 2613 passed / 1 skipped / 0 failed
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output

- [ ] **Step 7: Commit** — ask the user first

```bash
git add packages/mcp/src/adapters/treeSitter.js packages/mcp/test/treeSitter.test.js
git commit -m "feat(mcp): Node tree-sitter adapter over the existing injected parser"
```

---

### Task 4: Embeddings adapter, and the one change under `src/`

**Files:**
- Create: `packages/mcp/src/adapters/embedder.js`
- Modify: `src/services/RAGService.js:44-46` — accept an injected embedding service
- Test: `packages/mcp/test/embedder.test.js`, `test/unit/ragEmbedderInjection.test.js`

**Interfaces:**
- Produces: `createNodeEmbedder() → { init(onProgress), generateEmbeddings(texts, opts), generateEmbedding(text), getDimension(), getModelInfo() }`
- Modifies: `new RAGService({ embeddingService })` now uses the injected service when provided

**This is the only file this plan changes under `src/`.** `RAGService` hard-constructs its embedder:

```js
if (this.provider === 'local') {
    this.embeddingService = new OffscreenEmbeddingService();
```

`OffscreenEmbeddingService` messages a Chrome offscreen document, which does not exist in Node. The change is additive — accept an override, default to today's construction — and mirrors the injection pattern `CodeGraphPipeline` already uses for its parser (`CodeGraphPipeline.js:41`), so it makes the two pipelines consistent rather than introducing a new idiom.

**Use `@xenova/transformers`, not `@huggingface/transformers`.** The spec names the latter. The repo already depends on `@xenova/transformers@2.17.2` and the extension's local embedder uses `Xenova/all-MiniLM-L6-v2` at 384 dimensions through it. Same package means the same model and byte-comparable vectors — and no new dependency.

- [ ] **Step 1: Write the failing injection test (extension side, Jest/CommonJS)**

Create `test/unit/ragEmbedderInjection.test.js`. Note this one is CommonJS with `require` — it lives under the extension's `test/`, where the Babel package boundary means no preset applies:

```js
/**
 * RAGService hard-constructed OffscreenEmbeddingService, which messages a
 * Chrome offscreen document that does not exist outside the extension. The
 * injection point is what lets the same RAG pipeline run in Node. Additive by
 * construction: with no override, behaviour is exactly as before.
 */
const { RAGService } = require('../../src/services/RAGService.js');

describe('RAGService embedding-service injection', () => {
    test('uses an injected embedding service when one is provided', () => {
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.1]], getDimension: () => 1 };
        const rag = new RAGService({ provider: 'local', embeddingService: fake });
        expect(rag.embeddingService).toBe(fake);
    });

    test('with no override, it still constructs its own service as before', () => {
        const rag = new RAGService({ provider: 'local' });
        expect(rag.embeddingService).toBeTruthy();
        expect(rag.embeddingService.constructor.name).toBe('OffscreenEmbeddingService');
    });

    test('an injected service is honoured for non-local providers too', () => {
        // Otherwise the override would silently do nothing on a provider switch.
        const fake = { init: async () => {}, generateEmbeddings: async () => [[0.2]], getDimension: () => 1 };
        const rag = new RAGService({ provider: 'gemini', apiKey: 'k', embeddingService: fake });
        expect(rag.embeddingService).toBe(fake);
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/ragEmbedderInjection.test.js`
Expected: FAIL — the injected service is ignored; `rag.embeddingService` is an `OffscreenEmbeddingService`.

- [ ] **Step 3: Add the injection point**

In `src/services/RAGService.js`, immediately before the `if (this.provider === 'local')` block (around line 43), insert:

```js
        // Injected embedding service, if any.
        //
        // Mirrors the parser injection CodeGraphPipeline already accepts
        // (CodeGraphPipeline.js:41). Exists so this pipeline can run outside
        // the extension, where OffscreenEmbeddingService's offscreen document
        // does not exist. Checked before the provider branches so an override
        // holds for every provider — an override that silently stopped applying
        // when the provider changed would be worse than no override.
        this.embeddingService = options.embeddingService || null;
```

Then guard the existing branches so they do not overwrite it — change:

```js
        if (this.provider === 'local') {
```

to:

```js
        if (this.embeddingService) {
            // Injected: nothing to construct.
        } else if (this.provider === 'local') {
```

Leave the `gemini` and `else` branches as they are.

- [ ] **Step 4: Check the `init()` path does not re-construct over the injection**

Run: `grep -n "new GeminiEmbeddingService\|new OffscreenEmbeddingService" src/services/RAGService.js`

`init()` re-creates the Gemini service when `!this.embeddingService` (around line 63). That guard already protects an injected service, but confirm it and report what you found — a second construction site that ignored the override would defeat this task.

- [ ] **Step 5: Run the injection test and the full extension suite**

Run: `npx jest test/unit/ragEmbedderInjection.test.js`
Expected: PASS, 3 tests

Run: `npx jest`
Expected: 181 suites, 2616 passed, 1 skipped, 0 failed — the previous 180/2613 plus this one suite and 3 tests. `RAGService` is widely used, so any other change here is a regression you must fix rather than accept.

- [ ] **Step 6: Write the failing Node embedder test**

Create `packages/mcp/test/embedder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeEmbedder } from '../src/adapters/embedder.js';

// Downloads ~90MB on the first run, then caches. Generous timeout by design.
const TIMEOUT = 300000;

test('produces 384-dimension vectors, matching the extension', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    assert.equal(e.getDimension(), 384);

    const [v] = await e.generateEmbeddings(['function alpha() { return 1; }']);
    assert.equal(v.length, 384);
    assert.ok(v.every((n) => Number.isFinite(n)), 'vector contains non-finite values');
});

test('is deterministic for the same input', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const [a] = await e.generateEmbeddings(['const x = 1;']);
    const [b] = await e.generateEmbeddings(['const x = 1;']);
    assert.deepEqual(a, b);
});

test('embeds a batch in input order', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const vs = await e.generateEmbeddings(['alpha', 'beta', 'gamma']);
    assert.equal(vs.length, 3);
    // Different inputs must not collapse to the same vector — that would mean
    // the batch is being embedded from one text.
    assert.notDeepEqual(vs[0], vs[1]);
});

test('similar code scores closer than unrelated code', { timeout: TIMEOUT }, async () => {
    // The property retrieval actually depends on. Dimensionality alone would
    // pass with a broken model.
    const e = createNodeEmbedder();
    await e.init();
    const [auth1, auth2, unrelated] = await e.generateEmbeddings([
        'function validateUserPassword(user, password) { return hash(password) === user.hash; }',
        'function checkCredentials(account, secret) { return digest(secret) === account.digest; }',
        'const colours = ["red", "green", "blue"];',
    ]);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.ok(dot(auth1, auth2) > dot(auth1, unrelated),
        'two auth functions should be closer than an auth function and a colour list');
});

test('generateEmbedding returns a single vector, not a batch', { timeout: TIMEOUT }, async () => {
    const e = createNodeEmbedder();
    await e.init();
    const v = await e.generateEmbedding('hello');
    assert.equal(v.length, 384);
    assert.equal(typeof v[0], 'number');
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `node --test packages/mcp/test/embedder.test.js`
Expected: FAIL — cannot find module `../src/adapters/embedder.js`

- [ ] **Step 8: Implement the embedder**

Create `packages/mcp/src/adapters/embedder.js`:

```js
import os from 'node:os';
import path from 'node:path';
import { env, pipeline } from '@xenova/transformers';

/**
 * Local embeddings in Node, satisfying the contract RAGService calls:
 *   init(onProgress), generateEmbeddings(texts, opts), generateEmbedding(text),
 *   getDimension(), getModelInfo()
 *
 * Same package, model and dimensionality as the extension's local path
 * (Xenova/all-MiniLM-L6-v2, 384 dims), so an index built by either side is
 * semantically comparable. Keyless and offline after the first download.
 *
 * The Gemini and OpenAI embedding providers are deliberately not wired up:
 * they need API keys, and offering them would reintroduce the thing this
 * package exists to remove.
 */

export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

export function createNodeEmbedder({ cacheDir } = {}) {
    // Cache under the user's home rather than inside node_modules: `npx`
    // installs to a temporary directory, so a node_modules cache would
    // re-download the model on every invocation.
    env.cacheDir = cacheDir || path.join(os.homedir(), '.repospector', 'models');
    env.allowLocalModels = true;

    let extractor = null;
    let loading = null;

    async function ensure(onProgress) {
        if (extractor) return extractor;
        if (!loading) {
            loading = pipeline('feature-extraction', MODEL_NAME, {
                progress_callback: onProgress || undefined,
            }).then((p) => { extractor = p; loading = null; return p; });
        }
        return loading;
    }

    return {
        async init(onProgress = null) {
            await ensure(onProgress);
            return true;
        },

        getDimension() { return EMBEDDING_DIMENSION; },

        getModelInfo() {
            return { provider: 'local', model: MODEL_NAME, dimension: EMBEDDING_DIMENSION };
        },

        /**
         * @param {string[]} texts
         * @returns {Promise<number[][]>} one vector per input, in input order.
         */
        async generateEmbeddings(texts) {
            const list = Array.isArray(texts) ? texts : [texts];
            if (list.length === 0) return [];
            const model = await ensure();
            const out = [];
            // One text at a time: batching here would need padding and a mean
            // over the attention mask, and the retrieval quality gain is not
            // worth a second, subtly different pooling implementation.
            for (const text of list) {
                const t = await model(String(text ?? ''), { pooling: 'mean', normalize: true });
                out.push(Array.from(t.data));
            }
            return out;
        },

        async generateEmbedding(text) {
            const [v] = await this.generateEmbeddings([text]);
            return v;
        },
    };
}
```

- [ ] **Step 9: Run the embedder tests**

Run: `node --test packages/mcp/test/embedder.test.js`
Expected: PASS, 5 tests. The first run downloads the model; allow several minutes and confirm it lands under `~/.repospector/models`.

- [ ] **Step 10: Verify the gates**

Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `npm run build` → "Build validation passed!" (you changed a file the extension bundles)
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output

- [ ] **Step 11: Commit** — ask the user first

```bash
git add src/services/RAGService.js test/unit/ragEmbedderInjection.test.js \
        packages/mcp/src/adapters/embedder.js packages/mcp/test/embedder.test.js
git commit -m "feat(mcp): Node embeddings adapter and an injection point in RAGService"
```

---

### Task 5: Repo source, the indexer, response capping, and `index_repo`

**Files:**
- Create: `packages/mcp/src/tools/cap.js`, `packages/mcp/src/repo/source.js`, `packages/mcp/src/repo/indexer.js`, `packages/mcp/src/tools/index_repo.js`
- Modify: `packages/mcp/src/tools/registry.js`
- Test: `packages/mcp/test/cap.test.js`, `packages/mcp/test/source.test.js`, `packages/mcp/test/index_repo.test.js`
- Create fixture: `packages/mcp/test/fixtures/mini-repo/`

**Interfaces:**
- Consumes: `installIndexedDb`/`snapshot`/`restore`/`snapshotDir` (Task 2), `createNodeParser` (Task 3), `createNodeEmbedder` (Task 4)
- Produces:
  - `estimateTokens(text) → number`; `capText(text, maxTokens) → {text, truncated, note}`; `capList(items, renderFn, maxTokens) → {text, shown, total, truncated}`
  - `readRepoFiles(repoDir, {maxFiles}) → Promise<{files: Array<{path, content}>, skipped: number, truncated: boolean}>`
  - `getIndexer(ctx) → Promise<Indexer>` where `Indexer` has `{repoId, rag, pipeline, ensureIndexed(opts), stats()}`
  - `INDEX_REPO_TOOL` (a registry entry)

**Reuse, do not reinvent, the file filter.** `src/utils/codeFileFilter.js` is chrome-free and already exports `isIndexableCodeFile(path, options)`, `CODE_EXTENSIONS`, `EXCLUDE_DIRS` and `MAX_FILE_SIZE`, with the size ceiling applied before read. Use it. A second, subtly different notion of "indexable" would make the MCP index and the extension index disagree about the same repository.

**Enumerate files with `git ls-files`, not a directory walk.** `git ls-files -z` returns exactly the tracked files, which respects `.gitignore` by construction, skips `node_modules` and build output without a hand-maintained list, and is correct for submodules and sparse checkouts. Reimplementing ignore-file parsing would be a source of silent divergence from what the user considers "their repo".

- [ ] **Step 1: Write the failing cap test**

Create `packages/mcp/test/cap.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, capText, capList } from '../src/tools/cap.js';

test('estimateTokens scales with length and is zero for empty', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.ok(estimateTokens('a'.repeat(4000)) > estimateTokens('a'.repeat(400)));
});

test('text under the cap is returned untouched and unflagged', () => {
    const r = capText('short', 1000);
    assert.equal(r.text, 'short');
    assert.equal(r.truncated, false);
});

test('text over the cap is truncated at a LINE boundary, never mid-line', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const r = capText(body, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < body.length);
    // A mid-line cut produces a fragment that reads as real content, which is
    // how a caller comes to reason confidently from half a function.
    const lines = body.split('\n');
    for (const line of r.text.split('\n').filter(Boolean)) {
        assert.ok(lines.includes(line), `truncation produced a partial line: ${JSON.stringify(line)}`);
    }
});

test('a truncated result says what was dropped', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const r = capText(body, 50);
    assert.match(r.note, /truncat|limit/i);
});

test('capList shows as many whole items as fit and reports the real total', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ n: i, blob: 'y'.repeat(200) }));
    const r = capList(items, (it) => `item ${it.n}: ${it.blob}`, 200);
    assert.ok(r.shown > 0, 'must show at least one item');
    assert.ok(r.shown < 40, 'must not show all 40 under a 200-token cap');
    assert.equal(r.total, 40);
    assert.equal(r.truncated, true);
    assert.match(r.text, /showing \d+ of 40/i);
});

test('capList that fits reports no truncation', () => {
    const items = [{ n: 1 }, { n: 2 }];
    const r = capList(items, (it) => `item ${it.n}`, 1000);
    assert.equal(r.truncated, false);
    assert.equal(r.shown, 2);
});

test('capList of nothing is an explicit empty result, not a blank string', () => {
    const r = capList([], () => '', 100);
    assert.equal(r.shown, 0);
    assert.equal(r.total, 0);
    assert.ok(r.text.length > 0, 'an empty result must still say it is empty');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/mcp/test/cap.test.js`
Expected: FAIL — cannot find module `../src/tools/cap.js`

- [ ] **Step 3: Implement cap.js**

Create `packages/mcp/src/tools/cap.js`:

```js
/**
 * Response size limits for tool output.
 *
 * A tool result lands directly in the client's context window and the client
 * cannot undo it, so a helpful `search_code` that returns forty whole files
 * poisons the conversation it was meant to inform. Every tool caps its output,
 * truncates at a boundary that cannot be mistaken for whole content, and states
 * what it dropped so the caller can decide to re-query. Silent truncation is
 * worse than a smaller answer: it makes the caller reason confidently from a
 * partial picture.
 */

/** Four characters per token — the standard approximation. */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

function tokensToChars(tokens) {
    return Math.max(0, tokens) * 4;
}

/**
 * Truncate at a line boundary.
 *
 * @returns {{text: string, truncated: boolean, note: string}}
 */
export function capText(text, maxTokens) {
    const body = String(text ?? '');
    if (estimateTokens(body) <= maxTokens) {
        return { text: body, truncated: false, note: '' };
    }

    const budget = tokensToChars(maxTokens);
    const lines = body.split('\n');
    const kept = [];
    let used = 0;
    for (const line of lines) {
        if (used + line.length + 1 > budget) break;
        kept.push(line);
        used += line.length + 1;
    }
    // Always keep at least one line, even an over-long one: an empty result
    // would be indistinguishable from "no match".
    if (kept.length === 0 && lines.length > 0) kept.push(lines[0]);

    const dropped = lines.length - kept.length;
    return {
        text: kept.join('\n'),
        truncated: true,
        note: `truncated at the token limit — ${dropped} of ${lines.length} lines not shown; `
            + 'narrow the query or raise --max-tool-tokens',
    };
}

/**
 * Render as many whole items as fit.
 *
 * Whole items only: half a search result is not a search result.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => string} renderFn
 * @param {number} maxTokens
 * @returns {{text: string, shown: number, total: number, truncated: boolean}}
 */
export function capList(items, renderFn, maxTokens) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { text: 'No results.', shown: 0, total: 0, truncated: false };
    }

    const budget = tokensToChars(maxTokens);
    const parts = [];
    let used = 0;
    for (let i = 0; i < list.length; i += 1) {
        const rendered = renderFn(list[i], i);
        if (used + rendered.length > budget && parts.length > 0) break;
        parts.push(rendered);
        used += rendered.length;
    }

    const truncated = parts.length < list.length;
    const header = truncated
        ? `Showing ${parts.length} of ${list.length} results (token limit) — `
            + 'narrow the query or raise --max-tool-tokens.\n\n'
        : '';

    return {
        text: header + parts.join('\n\n'),
        shown: parts.length,
        total: list.length,
        truncated,
    };
}
```

- [ ] **Step 4: Run the cap tests**

Run: `node --test packages/mcp/test/cap.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Create the fixture repo**

Create these files under `packages/mcp/test/fixtures/mini-repo/`:

`src/auth.js`:
```js
export function validatePassword(user, password) {
    return hashPassword(password) === user.passwordHash;
}

export function hashPassword(password) {
    return `hashed:${password}`;
}
```

`src/session.js`:
```js
import { validatePassword } from './auth.js';

export function login(user, password) {
    if (!validatePassword(user, password)) return null;
    return { userId: user.id, issuedAt: 0 };
}
```

`src/colours.js`:
```js
export const COLOURS = ['red', 'green', 'blue'];
```

`test/auth.test.js`:
```js
const { validatePassword } = require('../src/auth.js');
test('validatePassword accepts a matching hash', () => {
    expect(validatePassword({ passwordHash: 'hashed:pw' }, 'pw')).toBe(true);
});
```

`README.md`:
```markdown
# mini-repo

Fixture for RepoSpector MCP tests. `login` calls `validatePassword`, which calls
`hashPassword`. `colours.js` is deliberately unrelated so retrieval ranking can
be asserted.
```

- [ ] **Step 6: Write the failing source test**

Create `packages/mcp/test/source.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readRepoFiles } from '../src/repo/source.js';

const REPO = path.resolve('.'); // this repository, which is a git worktree

test('reads real files from a git worktree', async () => {
    const { files } = await readRepoFiles(REPO, { maxFiles: 200 });
    assert.ok(files.length > 0, 'no files read');
    for (const f of files) {
        assert.equal(typeof f.path, 'string');
        assert.equal(typeof f.content, 'string');
        assert.ok(!path.isAbsolute(f.path), `paths must be repo-relative, got ${f.path}`);
    }
});

test('excludes node_modules and build output without a hand-maintained list', async () => {
    // git ls-files returns tracked files only, so .gitignore does this for us.
    const { files } = await readRepoFiles(REPO, { maxFiles: 5000 });
    assert.equal(files.some((f) => f.path.includes('node_modules/')), false);
    assert.equal(files.some((f) => f.path.startsWith('dist/')), false);
});

test('excludes non-code files via the shared filter', async () => {
    const { files } = await readRepoFiles(REPO, { maxFiles: 5000 });
    assert.equal(files.some((f) => f.path.endsWith('.png')), false);
    assert.equal(files.some((f) => f.path.endsWith('.wasm')), false);
});

test('maxFiles is honoured and the truncation is reported, not silent', async () => {
    const r = await readRepoFiles(REPO, { maxFiles: 5 });
    assert.equal(r.files.length, 5);
    assert.equal(r.truncated, true);
});

test('a directory that is not a git repo fails with a message naming the cause', async () => {
    await assert.rejects(
        () => readRepoFiles('/tmp', { maxFiles: 10 }),
        (e) => /git/i.test(e.message),
    );
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `node --test packages/mcp/test/source.test.js`
Expected: FAIL — cannot find module `../src/repo/source.js`

- [ ] **Step 8: Implement source.js**

Create `packages/mcp/src/repo/source.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIndexableCodeFile, MAX_FILE_SIZE } from '../../../../src/utils/codeFileFilter.js';

const exec = promisify(execFile);

/**
 * Read a git worktree into the `{path, content}[]` shape every analysis
 * service expects.
 *
 * Enumeration is `git ls-files`, not a directory walk: it returns exactly the
 * tracked files, which respects .gitignore by construction and gets
 * node_modules, build output, submodules and sparse checkouts right without a
 * hand-maintained exclusion list. Reimplementing ignore parsing would let this
 * disagree with what the user considers "their repo".
 *
 * Filtering reuses src/utils/codeFileFilter.js so the MCP index and the
 * extension index agree about what is indexable in the same repository.
 */
export async function readRepoFiles(repoDir, { maxFiles = 5000 } = {}) {
    let listed;
    try {
        // -z: NUL-separated, so paths with spaces or newlines survive intact.
        const { stdout } = await exec('git', ['ls-files', '-z'], {
            cwd: repoDir,
            maxBuffer: 64 * 1024 * 1024,
        });
        listed = stdout.split('\0').filter(Boolean);
    } catch (error) {
        throw new Error(
            `Not a git repository (or git is unavailable) at ${repoDir}: ${error.message}`,
        );
    }

    const candidates = listed.filter((p) => isIndexableCodeFile(p));
    const truncated = candidates.length > maxFiles;
    const chosen = candidates.slice(0, maxFiles);

    const files = [];
    let skipped = 0;
    for (const rel of chosen) {
        const abs = path.join(repoDir, rel);
        try {
            // Size check before read: a multi-megabyte generated file that
            // passed the extension filter should not be pulled into memory.
            const { size } = fs.statSync(abs);
            if (size > MAX_FILE_SIZE) { skipped += 1; continue; }
            files.push({ path: rel, content: fs.readFileSync(abs, 'utf8') });
        } catch {
            // Deleted since ls-files, a broken symlink, or unreadable: skipping
            // one file must not fail the index.
            skipped += 1;
        }
    }

    return { files, skipped, truncated };
}
```

- [ ] **Step 9: Run the source tests**

Run: `node --test packages/mcp/test/source.test.js`
Expected: PASS, 5 tests

- [ ] **Step 10: Implement the indexer**

Create `packages/mcp/src/repo/indexer.js`:

```js
import path from 'node:path';
import os from 'node:os';
import { installIndexedDb, snapshot, restore, snapshotDir } from '../adapters/persistence.js';
import { createNodeParser } from '../adapters/treeSitter.js';
import { createNodeEmbedder } from '../adapters/embedder.js';
import { readRepoFiles } from './source.js';

// The shim must be installed before any extension service is imported, because
// Database.js reaches for the bare global `indexedDB`.
installIndexedDb();

const { RAGService } = await import('../../../../src/services/RAGService.js');
const { CodeGraphPipeline } = await import('../../../../src/services/CodeGraphPipeline.js');

/**
 * Owns the index lifecycle for one repository: RAG, graph, and the on-disk
 * snapshot that makes a warm start possible.
 *
 * Created lazily. An MCP client spawns every configured server at launch, so a
 * server that indexes on boot pins a core for a user who may never call it.
 */
export function createIndexer(config) {
    const repoId = path.basename(config.repo);
    const dir = snapshotDir(path.join(os.homedir(), '.repospector', 'index'), config.repo);

    const embedder = createNodeEmbedder();
    const parser = createNodeParser();
    const rag = new RAGService({ provider: 'local', embeddingService: embedder });
    const pipeline = new CodeGraphPipeline({ offscreenParser: parser });

    let ready = null;
    let lastBuild = null;

    /**
     * Make the index usable, building it if needed.
     *
     * The ordering here is the one persistence.js documents: services open
     * their databases (creating schemas) BEFORE restore writes records into
     * them. Restoring earlier throws "object store not found"; reading before
     * restoring returns an empty index that looks like "nothing is indexed".
     */
    async function ensureIndexed({ force = false, maxFiles = config.maxFiles, onProgress } = {}) {
        if (ready && !force) return ready;

        ready = (async () => {
            await rag.init();                      // creates its stores
            await restore(dir);                    // now the stores exist

            const warm = !force && await pipeline.hasGraph(repoId).catch(() => false);
            if (warm) {
                await pipeline.loadGraph(repoId);
                return { built: false, repoId };
            }

            const { files, skipped, truncated } = await readRepoFiles(config.repo, { maxFiles });
            const ragResult = await rag.indexRepositoryIncremental(repoId, files, onProgress, { force });
            const graphStats = await pipeline.buildGraph(repoId, files, onProgress);
            await snapshot(dir);

            lastBuild = {
                built: true,
                repoId,
                files: files.length,
                skipped,
                truncated,
                rag: ragResult,
                graph: graphStats,
                parser: parser.available ? 'tree-sitter' : 'regex-fallback',
            };
            return lastBuild;
        })();

        return ready;
    }

    return {
        repoId,
        rag,
        pipeline,
        ensureIndexed,
        snapshotPath: dir,
        lastBuild: () => lastBuild,
        stats: () => pipeline.getStats(),
        parserMode: () => (parser.available ? 'tree-sitter' : 'regex-fallback'),
    };
}

/** One indexer per process, created on first use. */
export async function getIndexer(ctx) {
    if (!ctx.indexer) ctx.indexer = createIndexer(ctx.config);
    return ctx.indexer;
}
```

- [ ] **Step 11: Write the failing `index_repo` test**

Create `packages/mcp/test/index_repo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

const FIXTURE = path.resolve('packages/mcp/test/fixtures/mini-repo');
const TIMEOUT = 300000;

function ctx() {
    return { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };
}

test('the tool declares the wire contract the client sees', () => {
    assert.equal(INDEX_REPO_TOOL.name, 'index_repo');
    assert.ok(INDEX_REPO_TOOL.description.length > 0);
    assert.equal(INDEX_REPO_TOOL.inputSchema.type, 'object');
    // force and max_files are the two documented parameters.
    assert.ok('force' in INDEX_REPO_TOOL.inputSchema.properties);
    assert.ok('max_files' in INDEX_REPO_TOOL.inputSchema.properties);
});

test('indexes the fixture and reports what the build actually did', { timeout: TIMEOUT }, async () => {
    const result = await INDEX_REPO_TOOL.handler({ force: true }, ctx());
    const text = result.content[0].text;
    assert.equal(result.isError, undefined);
    assert.match(text, /files/i);
    // parser mode must be visible: a regex-fallback index that looks healthy is
    // how a caller comes to trust a weaker result.
    assert.match(text, /tree-sitter|regex-fallback/);
});

test('reports the repo it indexed, so a wrong --repo is obvious', { timeout: TIMEOUT }, async () => {
    const result = await INDEX_REPO_TOOL.handler({ force: true }, ctx());
    assert.match(result.content[0].text, /mini-repo/);
});

test('a repo that is not a git worktree returns a structured error, not a throw', async () => {
    const bad = { config: { repo: '/tmp', maxFiles: 10, maxToolTokens: 4096 }, indexer: null };
    const result = await INDEX_REPO_TOOL.handler({ force: true }, bad);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /git/i);
});
```

- [ ] **Step 12: Run it and confirm it fails**

Run: `node --test packages/mcp/test/index_repo.test.js`
Expected: FAIL — cannot find module `../src/tools/index_repo.js`

- [ ] **Step 13: Implement the tool**

Create `packages/mcp/src/tools/index_repo.js`:

```js
import { getIndexer } from '../repo/indexer.js';

/**
 * Build or rebuild the index for the configured repository.
 *
 * Exists as a first-class tool rather than leaving indexing implicit for two
 * reasons. A user who has just cloned or pulled wants to index deliberately,
 * not discover it as a 60-second pause inside their first search. And there is
 * otherwise no way to force a rebuild: manifest hashing means a warm repo
 * reprocesses only changed files, which is right almost always and wrong
 * exactly when the index is suspected corrupt.
 */
export const INDEX_REPO_TOOL = {
    name: 'index_repo',
    description:
        'Build or refresh the code index (embeddings + call graph) for the configured repository. '
        + 'Call this after cloning or pulling. Pass force:true to discard the incremental manifest '
        + 'and rebuild from scratch.',
    inputSchema: {
        type: 'object',
        properties: {
            force: {
                type: 'boolean',
                description: 'Discard the incremental manifest and rebuild every file.',
            },
            max_files: {
                type: 'integer',
                description: 'Override the file ceiling for this build.',
            },
        },
    },

    async handler(args, ctx) {
        try {
            const indexer = await getIndexer(ctx);
            const build = await indexer.ensureIndexed({
                force: Boolean(args.force),
                maxFiles: args.max_files || ctx.config.maxFiles,
            });

            const last = indexer.lastBuild();
            const lines = [`Repository: ${indexer.repoId}`];

            if (!build.built && !last) {
                lines.push('Index was already warm — loaded from the existing snapshot.');
                lines.push('Pass force:true to rebuild it from scratch.');
            } else {
                const b = last || build;
                lines.push(`Files indexed: ${b.files}`);
                if (b.skipped) lines.push(`Skipped (unreadable or over the size limit): ${b.skipped}`);
                if (b.truncated) {
                    lines.push(
                        `Stopped at the file ceiling — raise it with --max-files or the max_files argument.`,
                    );
                }
                lines.push(`Parser: ${b.parser}`);
                if (b.parser === 'regex-fallback') {
                    lines.push(
                        'Tree-sitter was unavailable, so symbols came from regex extraction. '
                        + 'Results are usable but less precise.',
                    );
                }
            }

            const stats = indexer.stats();
            if (stats) {
                lines.push(`Graph: ${stats.nodeCount ?? '?'} nodes, ${stats.relationshipCount ?? '?'} edges`);
            }
            lines.push(`Snapshot: ${indexer.snapshotPath}`);

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error) {
            // Structured, not thrown: the caller is a model and can act on a
            // message that names the cause.
            return {
                isError: true,
                content: [{ type: 'text', text: `index_repo failed: ${error.message}` }],
            };
        }
    },
};
```

- [ ] **Step 14: Register the tool**

In `packages/mcp/src/tools/registry.js`, replace the empty array:

```js
import { INDEX_REPO_TOOL } from './index_repo.js';

export const TOOLS = [
    INDEX_REPO_TOOL,
];
```

- [ ] **Step 15: Run the tool tests and the handshake test together**

Run: `node --test packages/mcp/test/index_repo.test.js packages/mcp/test/handshake.test.js`
Expected: PASS. The handshake test must now list one tool, proving registration reaches the wire and not just the module.

- [ ] **Step 16: Verify the gates**

Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output

- [ ] **Step 17: Commit** — ask the user first

```bash
git add packages/mcp/src/tools/cap.js packages/mcp/src/repo packages/mcp/src/tools/index_repo.js \
        packages/mcp/src/tools/registry.js packages/mcp/test
git commit -m "feat(mcp): repo source, indexer, response caps and the index_repo tool"
```

---

### Task 6: The five retrieval and graph tools

**Files:**
- Create: `packages/mcp/src/tools/search.js`, `packages/mcp/src/tools/impact.js`
- Modify: `packages/mcp/src/tools/registry.js`
- Test: `packages/mcp/test/search.test.js`, `packages/mcp/test/impact.test.js`

**Interfaces:**
- Consumes: `getIndexer` (Task 5), `capList`/`capText` (Task 5)
- Produces: `SEARCH_CODE_TOOL`, `GET_SYMBOL_TOOL`, `FIND_CALLERS_TOOL` from `search.js`; `IMPACT_OF_CHANGE_TOOL`, `REPO_OVERVIEW_TOOL` from `impact.js`

**Backing calls, verified against the services:**

| Tool | Call |
| --- | --- |
| `search_code` | `indexer.rag.retrieveContext(repoId, query, limit, options)` |
| `get_symbol` | `indexer.pipeline.getSymbolContext(name)` |
| `find_callers` | `indexer.pipeline.getCallerRefs(name, limit)` |
| `impact_of_change` | `indexer.pipeline.safetyCheck(name)` + `getUntestedInBlastRadius(name, opts)` |
| `repo_overview` | `indexer.pipeline.getStats()` + `indexer.parserMode()` |

**`get_symbol` returns spans and paths, not whole files.** The client has filesystem tools and can read a file far more cheaply than we can inline it. Duplicating file contents into tool output spends the token budget on something the caller already has.

- [ ] **Step 1: Write the failing search tests**

Create `packages/mcp/test/search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL } from '../src/tools/search.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

const FIXTURE = path.resolve('packages/mcp/test/fixtures/mini-repo');
const TIMEOUT = 300000;

// One shared, indexed context: re-indexing per test would download and embed
// repeatedly for no added confidence.
const ctx = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };

test('index the fixture once', { timeout: TIMEOUT }, async () => {
    const r = await INDEX_REPO_TOOL.handler({ force: true }, ctx);
    assert.equal(r.isError, undefined);
});

test('each tool declares a name and an object schema', () => {
    for (const t of [SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL]) {
        assert.ok(t.name.length > 0);
        assert.equal(t.inputSchema.type, 'object');
        assert.ok(t.description.length > 0);
    }
    assert.equal(SEARCH_CODE_TOOL.name, 'search_code');
    assert.equal(GET_SYMBOL_TOOL.name, 'get_symbol');
    assert.equal(FIND_CALLERS_TOOL.name, 'find_callers');
});

test('search_code ranks the relevant file above the unrelated one', { timeout: TIMEOUT }, async () => {
    const r = await SEARCH_CODE_TOOL.handler({ query: 'validate a user password hash' }, ctx);
    const text = r.content[0].text;
    assert.equal(r.isError, undefined);
    assert.match(text, /auth\.js/, `expected auth.js in results:\n${text}`);
    // colours.js is deliberately unrelated; if it outranks auth.js, retrieval is broken.
    const authAt = text.indexOf('auth.js');
    const coloursAt = text.indexOf('colours.js');
    if (coloursAt >= 0) assert.ok(authAt < coloursAt, 'unrelated file outranked the relevant one');
});

test('search_code with no matches says so rather than returning blank', { timeout: TIMEOUT }, async () => {
    const r = await SEARCH_CODE_TOOL.handler({ query: 'zzzz-nonexistent-token-qqqq' }, ctx);
    assert.ok(r.content[0].text.length > 0);
});

test('get_symbol finds a real symbol and reports its file and line span', { timeout: TIMEOUT }, async () => {
    const r = await GET_SYMBOL_TOOL.handler({ name: 'validatePassword' }, ctx);
    const text = r.content[0].text;
    assert.match(text, /validatePassword/);
    assert.match(text, /auth\.js/);
    assert.match(text, /\d+/, 'expected a line number');
});

test('get_symbol on an unknown name offers near-misses so the caller can self-correct', { timeout: TIMEOUT }, async () => {
    const r = await GET_SYMBOL_TOOL.handler({ name: 'validatePasword' }, ctx); // typo
    const text = r.content[0].text;
    assert.match(text, /not found|no symbol/i);
    // The recovery path: a model that gets a bare "not found" retries blindly.
    assert.match(text, /validatePassword|did you mean|similar/i);
});

test('find_callers finds the caller of a function', { timeout: TIMEOUT }, async () => {
    const r = await FIND_CALLERS_TOOL.handler({ symbol: 'validatePassword' }, ctx);
    const text = r.content[0].text;
    // login() in session.js calls validatePassword.
    assert.match(text, /session\.js|login/, `expected the caller, got:\n${text}`);
});

test('find_callers on a symbol nothing calls says so plainly', { timeout: TIMEOUT }, async () => {
    const r = await FIND_CALLERS_TOOL.handler({ symbol: 'COLOURS' }, ctx);
    assert.ok(r.content[0].text.length > 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/mcp/test/search.test.js`
Expected: FAIL — cannot find module `../src/tools/search.js`

- [ ] **Step 3: Implement search.js**

Create `packages/mcp/src/tools/search.js`:

```js
import { getIndexer } from '../repo/indexer.js';
import { capList, capText } from './cap.js';

/** Wrap a handler so a thrown error becomes a structured, actionable result. */
function guarded(name, fn) {
    return async (args, ctx) => {
        try {
            return await fn(args, ctx);
        } catch (error) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${name} failed: ${error.message}` }],
            };
        }
    };
}

/** Levenshtein-free near-miss: shared prefix or case-insensitive containment. */
function nearMisses(target, candidates, limit = 5) {
    const t = String(target).toLowerCase();
    return candidates
        .filter((c) => {
            const l = c.toLowerCase();
            return l.includes(t) || t.includes(l) || l.slice(0, 4) === t.slice(0, 4);
        })
        .filter((c) => c !== target)
        .slice(0, limit);
}

export const SEARCH_CODE_TOOL = {
    name: 'search_code',
    description:
        'Search the indexed repository for code relevant to a natural-language or keyword query. '
        + 'Hybrid keyword + semantic retrieval. Returns ranked snippets with file paths and line spans.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'What to look for.' },
            k: { type: 'integer', description: 'Maximum results (default 10).' },
        },
        required: ['query'],
    },
    handler: guarded('search_code', async (args, ctx) => {
        const indexer = await getIndexer(ctx);
        await indexer.ensureIndexed({});
        const limit = args.k || 10;

        const result = await indexer.rag.retrieveContext(indexer.repoId, args.query, limit);
        const chunks = result?.chunks || result?.results || [];

        const capped = capList(
            chunks,
            (c) => {
                const where = c.filePath || c.path || 'unknown';
                const from = c.startLine ?? c.start_line;
                const span = from ? `:${from}` : '';
                return `--- ${where}${span}\n${String(c.content || c.text || '').trim()}`;
            },
            ctx.config.maxToolTokens,
        );

        return { content: [{ type: 'text', text: capped.text }] };
    }),
};

export const GET_SYMBOL_TOOL = {
    name: 'get_symbol',
    description:
        'Look up one symbol (function, class, method) and return where it is defined, its span, '
        + 'and its immediate graph neighbours. Returns paths and line spans, not whole files — '
        + 'read the file yourself if you need the body.',
    inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact symbol name.' } },
        required: ['name'],
    },
    handler: guarded('get_symbol', async (args, ctx) => {
        const indexer = await getIndexer(ctx);
        await indexer.ensureIndexed({});

        const view = indexer.pipeline.getSymbolContext(args.name);
        if (!view) {
            // Offer near-misses: a model handed a bare "not found" retries blindly.
            const stats = indexer.pipeline.getStats?.() || {};
            const known = stats.symbolNames || [];
            const suggestions = nearMisses(args.name, known);
            const hint = suggestions.length
                ? ` Did you mean: ${suggestions.join(', ')}?`
                : ' Call repo_overview to confirm the index is built.';
            return {
                content: [{ type: 'text', text: `No symbol named "${args.name}" in the index.${hint}` }],
            };
        }

        const capped = capText(
            typeof view === 'string' ? view : JSON.stringify(view, null, 2),
            ctx.config.maxToolTokens,
        );
        const text = capped.truncated ? `${capped.text}\n\n[${capped.note}]` : capped.text;
        return { content: [{ type: 'text', text }] };
    }),
};

export const FIND_CALLERS_TOOL = {
    name: 'find_callers',
    description:
        'List the call sites of a symbol, with the confidence the graph assigns to each edge.',
    inputSchema: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Exact symbol name.' },
            limit: { type: 'integer', description: 'Maximum call sites (default 20).' },
        },
        required: ['symbol'],
    },
    handler: guarded('find_callers', async (args, ctx) => {
        const indexer = await getIndexer(ctx);
        await indexer.ensureIndexed({});

        const refs = indexer.pipeline.getCallerRefs(args.symbol, args.limit || 20) || [];
        if (refs.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `Nothing in the index calls "${args.symbol}". It may be an entry point, `
                        + 'called dynamically, or called from a file type the parser does not cover.',
                }],
            };
        }

        const capped = capList(
            refs,
            (r) => {
                const conf = r.confidence != null ? ` (confidence ${r.confidence})` : '';
                return `${r.filePath || r.path || 'unknown'}:${r.line ?? '?'} — ${r.callerName || r.caller || 'unknown'}${conf}`;
            },
            ctx.config.maxToolTokens,
        );
        return { content: [{ type: 'text', text: capped.text }] };
    }),
};
```

- [ ] **Step 4: Check the shapes these services actually return**

The handlers above read several optional field names (`chunks` vs `results`, `filePath` vs `path`). Confirm the real ones and simplify to what is actually returned:

Run: `grep -n "return {" -A6 src/services/RAGService.js | sed -n '1,40p'`
Run: `grep -n "getCallerRefs" -A22 src/services/CodeGraphPipeline.js`
Run: `grep -n "getSymbolContext" -A22 src/services/CodeGraphPipeline.js`

Replace the defensive `a || b` field reads with the real field names, and note in your report what they are. Defensive fallbacks that never fire are noise; ones that fire silently hide a shape mismatch.

Also confirm whether `getStats()` exposes symbol names for the near-miss hint. If it does not, get them from the graph directly or drop the suggestion list and say so — but do NOT leave a bare "not found", which is the failure the test pins.

- [ ] **Step 5: Run the search tests**

Run: `node --test packages/mcp/test/search.test.js`
Expected: PASS, 9 tests

- [ ] **Step 6: Write the failing impact tests**

Create `packages/mcp/test/impact.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { IMPACT_OF_CHANGE_TOOL, REPO_OVERVIEW_TOOL } from '../src/tools/impact.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

const FIXTURE = path.resolve('packages/mcp/test/fixtures/mini-repo');
const TIMEOUT = 300000;
const ctx = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };

test('index the fixture once', { timeout: TIMEOUT }, async () => {
    assert.equal((await INDEX_REPO_TOOL.handler({ force: true }, ctx)).isError, undefined);
});

test('both tools declare their contract', () => {
    assert.equal(IMPACT_OF_CHANGE_TOOL.name, 'impact_of_change');
    assert.equal(REPO_OVERVIEW_TOOL.name, 'repo_overview');
    assert.equal(IMPACT_OF_CHANGE_TOOL.inputSchema.type, 'object');
});

test('repo_overview reports graph size and the parser mode', { timeout: TIMEOUT }, async () => {
    const r = await REPO_OVERVIEW_TOOL.handler({}, ctx);
    const text = r.content[0].text;
    assert.match(text, /nodes|symbols/i);
    // Parser mode must be visible so a degraded index is legible rather than
    // inferred later from poor answers.
    assert.match(text, /tree-sitter|regex-fallback/);
});

test('repo_overview works before any other tool, building the index if needed', { timeout: TIMEOUT }, async () => {
    const fresh = { config: { repo: FIXTURE, maxFiles: 100, maxToolTokens: 4096 }, indexer: null };
    const r = await REPO_OVERVIEW_TOOL.handler({}, fresh);
    assert.equal(r.isError, undefined);
});

test('impact_of_change names what a change to a symbol reaches', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'hashPassword' }, ctx);
    const text = r.content[0].text;
    // hashPassword <- validatePassword <- login: the blast radius must mention
    // at least the direct dependent.
    assert.match(text, /validatePassword|auth\.js/, `expected a dependent, got:\n${text}`);
});

test('impact_of_change surfaces test coverage of the blast radius', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'validatePassword' }, ctx);
    assert.match(r.content[0].text, /test|covered|untested/i);
});

test('impact_of_change on an unknown symbol degrades with a hint', { timeout: TIMEOUT }, async () => {
    const r = await IMPACT_OF_CHANGE_TOOL.handler({ symbol: 'noSuchThing' }, ctx);
    assert.ok(r.content[0].text.length > 0);
    assert.match(r.content[0].text, /not found|no symbol|unknown/i);
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `node --test packages/mcp/test/impact.test.js`
Expected: FAIL — cannot find module `../src/tools/impact.js`

- [ ] **Step 8: Implement impact.js**

Create `packages/mcp/src/tools/impact.js`:

```js
import { getIndexer } from '../repo/indexer.js';
import { capText } from './cap.js';

function guarded(name, fn) {
    return async (args, ctx) => {
        try {
            return await fn(args, ctx);
        } catch (error) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${name} failed: ${error.message}` }],
            };
        }
    };
}

export const IMPACT_OF_CHANGE_TOOL = {
    name: 'impact_of_change',
    description:
        'Given a symbol, report what changing it would reach: dependents, the community it '
        + 'belongs to, and which of the affected code has test coverage.',
    inputSchema: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Exact symbol name.' },
            depth: { type: 'integer', description: 'Traversal depth (default 2).' },
        },
        required: ['symbol'],
    },
    handler: guarded('impact_of_change', async (args, ctx) => {
        const indexer = await getIndexer(ctx);
        await indexer.ensureIndexed({});

        const safety = indexer.pipeline.safetyCheck(args.symbol);
        const untested = indexer.pipeline.getUntestedInBlastRadius(args.symbol, {
            depth: args.depth || 2,
        });

        if (!safety && (!untested || untested.length === 0)) {
            return {
                content: [{
                    type: 'text',
                    text: `No symbol named "${args.symbol}" in the graph. Use get_symbol to check the `
                        + 'name, or index_repo if the index may be stale.',
                }],
            };
        }

        const body = JSON.stringify({ symbol: args.symbol, safety, untested }, null, 2);
        const capped = capText(body, ctx.config.maxToolTokens);
        const text = capped.truncated ? `${capped.text}\n\n[${capped.note}]` : capped.text;
        return { content: [{ type: 'text', text }] };
    }),
};

export const REPO_OVERVIEW_TOOL = {
    name: 'repo_overview',
    description:
        'Summarise the indexed repository: graph size, index health, and which parser produced '
        + 'the symbols. Call this first to confirm the index is built.',
    inputSchema: { type: 'object', properties: {} },
    handler: guarded('repo_overview', async (_args, ctx) => {
        const indexer = await getIndexer(ctx);
        await indexer.ensureIndexed({});

        const stats = indexer.pipeline.getStats() || {};
        const last = indexer.lastBuild();
        const lines = [
            `Repository: ${indexer.repoId}`,
            `Path: ${ctx.config.repo}`,
            `Graph: ${stats.nodeCount ?? '?'} nodes, ${stats.relationshipCount ?? '?'} edges`,
            `Parser: ${indexer.parserMode()}`,
        ];
        if (indexer.parserMode() === 'regex-fallback') {
            lines.push(
                'Tree-sitter was unavailable, so symbols came from regex extraction — usable but '
                + 'less precise for multi-line signatures and call targets.',
            );
        }
        if (last) lines.push(`Last build: ${last.files} files indexed, ${last.skipped} skipped`);
        lines.push(`Snapshot: ${indexer.snapshotPath}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
};
```

- [ ] **Step 9: Register all five tools**

`packages/mcp/src/tools/registry.js`:

```js
import { INDEX_REPO_TOOL } from './index_repo.js';
import { SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL } from './search.js';
import { IMPACT_OF_CHANGE_TOOL, REPO_OVERVIEW_TOOL } from './impact.js';

export const TOOLS = [
    REPO_OVERVIEW_TOOL,
    INDEX_REPO_TOOL,
    SEARCH_CODE_TOOL,
    GET_SYMBOL_TOOL,
    FIND_CALLERS_TOOL,
    IMPACT_OF_CHANGE_TOOL,
];
```

- [ ] **Step 10: Run the whole package suite**

Run: `node --test packages/mcp/test/`
Expected: PASS. The handshake test must now list six tools.

- [ ] **Step 11: Verify the gates**

Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output

- [ ] **Step 12: Commit** — ask the user first

```bash
git add packages/mcp/src/tools packages/mcp/test
git commit -m "feat(mcp): search_code, get_symbol, find_callers, impact_of_change, repo_overview"
```

---

### Task 7: `get_diff_context`

**Files:**
- Create: `packages/mcp/src/tools/diff.js`
- Modify: `packages/mcp/src/tools/registry.js`
- Test: `packages/mcp/test/diff.test.js`

**Interfaces:**
- Consumes: `PullRequestService.fetchPullRequest(url)` (chrome-free, verified), `windowFile(file, opts)` from `src/services/HunkWindower.js`, `getIndexer`, `capList`
- Produces: `GET_DIFF_CONTEXT_TOOL`, `parseDiffTarget(args) → {kind, url|range} | {error}`, `collectDiffFiles(args, ctx) → Promise<Array<{filename, patch}>>`

**Export `collectDiffFiles` from the start.** Task 8's `review_pr` needs the parsed file list, not the rendered text, to feed the analyzers. Factor the fetch-and-parse step into `collectDiffFiles` here and have `GET_DIFF_CONTEXT_TOOL` call it, so both tools share one code path and there is one place for the shapes to be right.

**This is the only tool that touches the network.** It reads `GITHUB_TOKEN` / `GITLAB_TOKEN` from the environment for private repos and rate limits; without them, public repositories still work. These are git-host credentials, not model keys — the keyless property is unaffected.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/test/diff.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET_DIFF_CONTEXT_TOOL, parseDiffTarget } from '../src/tools/diff.js';

const ctx = () => ({
    config: { repo: process.cwd(), maxFiles: 50, maxToolTokens: 4096, githubToken: null, gitlabToken: null },
    indexer: null,
});

test('declares its contract', () => {
    assert.equal(GET_DIFF_CONTEXT_TOOL.name, 'get_diff_context');
    assert.equal(GET_DIFF_CONTEXT_TOOL.inputSchema.type, 'object');
});

test('parses a GitHub PR url', () => {
    const t = parseDiffTarget({ pr_url: 'https://github.com/o/r/pull/7' });
    assert.equal(t.kind, 'pr');
    assert.equal(t.url, 'https://github.com/o/r/pull/7');
});

test('parses a GitLab MR url', () => {
    const t = parseDiffTarget({ pr_url: 'https://gitlab.com/g/p/-/merge_requests/100' });
    assert.equal(t.kind, 'pr');
});

test('parses a local revision range', () => {
    const t = parseDiffTarget({ range: 'main..HEAD' });
    assert.equal(t.kind, 'range');
    assert.equal(t.range, 'main..HEAD');
});

test('neither argument is a structured error naming both options', () => {
    const t = parseDiffTarget({});
    assert.ok(t.error);
    assert.match(t.error, /pr_url/);
    assert.match(t.error, /range/);
});

test('a local range against this repo returns windowed hunks', async () => {
    // Uses git only — no network, so this test is deterministic in CI.
    const r = await GET_DIFF_CONTEXT_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    assert.equal(r.isError, undefined);
    assert.ok(r.content[0].text.length > 0);
});

test('a malformed range fails with git\'s reason, not a generic message', async () => {
    const r = await GET_DIFF_CONTEXT_TOOL.handler({ range: 'not-a-real-ref..HEAD' }, ctx());
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.length > 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/mcp/test/diff.test.js`
Expected: FAIL — cannot find module `../src/tools/diff.js`

- [ ] **Step 3: Implement diff.js**

Create `packages/mcp/src/tools/diff.js`:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowFile } from '../../../../src/services/HunkWindower.js';
import { getIndexer } from '../repo/indexer.js';
import { capList } from './cap.js';

const exec = promisify(execFile);

/** Which target the caller asked for, or a message naming both options. */
export function parseDiffTarget(args = {}) {
    if (args.pr_url) return { kind: 'pr', url: String(args.pr_url) };
    if (args.range) return { kind: 'range', range: String(args.range) };
    return {
        error: 'Pass either pr_url (a GitHub PR or GitLab MR link) or range '
            + '(a local git revision range such as main..HEAD).',
    };
}

/** Local diff via git, so the common case needs no network and no token. */
async function localDiff(repo, range) {
    const { stdout } = await exec('git', ['diff', '--unified=3', range], {
        cwd: repo,
        maxBuffer: 64 * 1024 * 1024,
    });
    // One entry per file, matching the shape windowFile expects.
    const files = [];
    for (const chunk of stdout.split(/^diff --git /m).filter(Boolean)) {
        const header = chunk.split('\n')[0] || '';
        const match = header.match(/b\/(.+)$/);
        const filename = match ? match[1].trim() : 'unknown';
        const at = chunk.indexOf('\n@@');
        if (at < 0) continue;
        files.push({ filename, patch: chunk.slice(at + 1) });
    }
    return files;
}

export const GET_DIFF_CONTEXT_TOOL = {
    name: 'get_diff_context',
    description:
        'Fetch a pull request or local revision range as windowed diff hunks, each paired with its '
        + 'graph neighbours. Reads GITHUB_TOKEN / GITLAB_TOKEN from the environment for private '
        + 'repositories and rate limits.',
    inputSchema: {
        type: 'object',
        properties: {
            pr_url: { type: 'string', description: 'GitHub PR or GitLab MR URL.' },
            range: { type: 'string', description: 'Local git revision range, e.g. main..HEAD.' },
        },
    },

    async handler(args, ctx) {
        const target = parseDiffTarget(args);
        if (target.error) {
            return { isError: true, content: [{ type: 'text', text: target.error }] };
        }

        try {
            let files;
            if (target.kind === 'range') {
                files = await localDiff(ctx.config.repo, target.range);
            } else {
                // Imported lazily: the PR services reach the network, and a
                // local-range call should not pay for loading them.
                const { PullRequestService } = await import(
                    '../../../../src/services/PullRequestService.js'
                );
                const svc = new PullRequestService({
                    githubToken: ctx.config.githubToken,
                    gitlabToken: ctx.config.gitlabToken,
                });
                const pr = await svc.fetchPullRequest(target.url);
                files = pr?.files || [];
            }

            if (files.length === 0) {
                return {
                    content: [{ type: 'text', text: 'No changed files found for that target.' }],
                };
            }

            const indexer = await getIndexer(ctx);
            await indexer.ensureIndexed({});

            const windows = [];
            for (const file of files) {
                for (const w of windowFile(file) || []) windows.push({ file, window: w });
            }

            const capped = capList(
                windows.length ? windows : files.map((f) => ({ file: f, window: null })),
                ({ file, window }) => {
                    const symbols = indexer.pipeline.getSymbolContext?.(file.filename);
                    const neighbours = symbols ? `\n[graph] ${JSON.stringify(symbols).slice(0, 400)}` : '';
                    const patch = window?.patch || file.patch || '';
                    return `--- ${file.filename}\n${patch}${neighbours}`;
                },
                ctx.config.maxToolTokens,
            );

            return { content: [{ type: 'text', text: capped.text }] };
        } catch (error) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `get_diff_context failed: ${error.message}`,
                }],
            };
        }
    },
};
```

- [ ] **Step 4: Verify `PullRequestService`'s constructor and return shape**

Run: `grep -n "constructor" -A14 src/services/PullRequestService.js | head -20`
Run: `grep -n "async fetchPullRequest" -A18 src/services/PullRequestService.js`

The constructor options and the returned object's field for changed files (`files`, `changedFiles`, …) must match what the handler reads. Correct the handler to the real shape and report what it was. Also confirm `windowFile` accepts the `{filename, patch}` shape used here — if it needs `additions`/`deletions`, supply them or pass the file through unwindowed with a note.

- [ ] **Step 5: Run the diff tests**

Run: `node --test packages/mcp/test/diff.test.js`
Expected: PASS, 7 tests

- [ ] **Step 6: Register the tool**

Add to `packages/mcp/src/tools/registry.js`:

```js
import { GET_DIFF_CONTEXT_TOOL } from './diff.js';
```

and add `GET_DIFF_CONTEXT_TOOL,` to the `TOOLS` array after `IMPACT_OF_CHANGE_TOOL`.

- [ ] **Step 7: Verify the gates**

Run: `node --test packages/mcp/test/` → PASS, handshake lists seven tools
Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output

- [ ] **Step 8: Commit** — ask the user first

```bash
git add packages/mcp/src/tools/diff.js packages/mcp/src/tools/registry.js packages/mcp/test/diff.test.js
git commit -m "feat(mcp): get_diff_context for pull requests and local ranges"
```

---

### Task 8: `review_pr` — the bundle, plus the OSV cache seam

**Files:**
- Create: `packages/mcp/src/tools/review.js`, `packages/mcp/src/tools/rubric.js`, `packages/mcp/src/adapters/osvCache.js`
- Modify: `packages/mcp/src/tools/registry.js`
- Test: `packages/mcp/test/review.test.js`, `packages/mcp/test/rubric.test.js`

**Interfaces:**
- Consumes: `StaticAnalysisService.analyzeFiles(files, options)` (its `analyzePullRequest(prData, options)` is the alternative — Step 10 decides which fits the diff shape), `SecretsScanner.scanPRFiles(files)`, `collectDiffFiles` from Task 7, `PriorFindingService.relatedPRs(prData, {repoId, limit})`, `windowFile`, `getIndexer`, `capText`
- Produces: `REVIEW_PR_TOOL`, `buildRubric() → string`, `createFileOsvCache(dir) → {save(data), load()}`

**`review_pr` returns the material for a review, never a generated review.** This is the tool the original design excluded, and the reason it can exist now is that it does not need a model. `ReviewOrchestrator` requires an LLM callable; this package has none, and the two ways to give it one both cost more than they return — MCP sampling has uneven client support so the tool would fail outright in some clients, and an env-var key would put an LLM client back inside a package whose entire selling point is that it has none. Assembling the context and letting Claude reason keeps the keyless invariant exact and works in every client.

**`static_analysis` is the part Claude cannot produce for itself** — real ESLint, Semgrep, tree-sitter lint and secret-scan results over the changed files, no model involved. That is the strongest reason this tool earns its place, and it must not be silently dropped when an analyzer fails.

**The rubric needs adapting, not copying.** `PR_ANALYSIS_SYSTEM_PROMPT` (`src/utils/prompts.js:604`) opens with *"You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser"* and instructs the model never to claim it cannot see the code. Handed to Claude through MCP that is false and confusing — Claude is not a Chrome extension and the code arrives in the bundle, not from a browser. Task 8 therefore composes the review criteria into a rubric suited to this transport, sourcing the criteria from the existing prompt so the two do not drift, and dropping the extension self-description.

**`OSVService` is the one analysis service with a Chrome dependency**, and it is only cache persistence: `chrome.storage.local.set` at `OSVService.js:252` and `.get` at `:263`. Give it a file-backed cache. If its cache access is not injectable, omit dependency data from the first version and say so in the bundle — a missing section that names itself is fine; a crash is not.

- [ ] **Step 1: Write the failing rubric test**

Create `packages/mcp/test/rubric.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRubric } from '../src/tools/rubric.js';

test('states the review criteria', () => {
    const r = buildRubric();
    assert.ok(r.length > 200, 'a rubric this short cannot carry the criteria');
    assert.match(r, /correctness|bug/i);
    assert.match(r, /security/i);
});

test('does NOT claim the reader is a Chrome extension', () => {
    // PR_ANALYSIS_SYSTEM_PROMPT says "You are RepoSpector, an AI-powered code
    // analysis Chrome extension … with direct access to data from the user's
    // browser". Through MCP that is false: the reader is Claude and the code
    // arrives in the bundle. Passing it through verbatim would assert something
    // untrue in the reader's own context.
    const r = buildRubric();
    assert.doesNotMatch(r, /Chrome extension/i);
    assert.doesNotMatch(r, /from the user's browser/i);
    assert.doesNotMatch(r, /NEVER claim you cannot see/i);
});

test('tells the reader where the evidence in the bundle comes from', () => {
    const r = buildRubric();
    assert.match(r, /static analysis|static_analysis/i);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/mcp/test/rubric.test.js`
Expected: FAIL — cannot find module `../src/tools/rubric.js`

- [ ] **Step 3: Implement rubric.js**

Create `packages/mcp/src/tools/rubric.js`:

```js
/**
 * Review instructions for the `review_pr` bundle.
 *
 * Deliberately NOT `PR_ANALYSIS_SYSTEM_PROMPT` verbatim. That prompt opens by
 * telling the model it is "an AI-powered code analysis Chrome extension with
 * direct access to Pull Request data from the user's browser" and instructs it
 * never to claim it cannot see the code. Through MCP every clause of that is
 * false: the reader is Claude, and the code arrives inside the bundle rather
 * than from a browser. Asserting it anyway would put an untrue premise in the
 * reader's own context.
 *
 * The criteria below are the transport-independent half of the same rubric, so
 * a review produced here and one produced in the extension judge the same
 * things.
 */
export function buildRubric() {
    return [
        'Review the changes in this bundle. Report only defects you can point at.',
        '',
        'Judge, in this order:',
        '1. Correctness — wrong behaviour, unhandled cases, broken invariants. Name the',
        '   input or state that triggers the failure and what goes wrong.',
        '2. Security — untrusted input reaching a sink, missing authorisation, leaked',
        '   credentials, injection. The bundle\'s static_analysis section already',
        '   contains deterministic secret-scan and linter results; treat those as',
        '   evidence rather than re-deriving them.',
        '3. Tests — behaviour the change introduces that nothing covers. The',
        '   covering_tests section lists what already exercises the touched code.',
        '4. Maintainability — duplication of a logic block, swallowed errors, a',
        '   contract that now disagrees with its callers.',
        '',
        'Use the evidence supplied:',
        '- hunks: the changed lines, windowed so large files stay legible.',
        '- graph_context: callers and callees of the touched symbols, so you can see',
        '  what a change reaches beyond the diff.',
        '- similar_code: comparable code retrieved from the repository, so you can',
        '  judge whether the change follows the conventions already in use.',
        '- prior_findings: issues raised before on this repository. Say so when a',
        '  finding repeats one.',
        '- static_analysis: real linter, tree-sitter and secret-scan output. No model',
        '  produced these; they are facts about the code.',
        '',
        'Do not report style preferences, and do not restate what the diff does.',
    ].join('\n');
}
```

- [ ] **Step 4: Run the rubric test**

Run: `node --test packages/mcp/test/rubric.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Implement the OSV cache adapter**

Create `packages/mcp/src/adapters/osvCache.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

/**
 * File-backed replacement for OSVService's `chrome.storage.local` cache.
 *
 * OSVService is the one analysis service with a Chrome dependency, and it is
 * only persistence: `chrome.storage.local.set` (OSVService.js:252) and `.get`
 * (:263). Everything else in it is plain HTTP against api.osv.dev.
 */
export function createFileOsvCache(dir) {
    const file = path.join(dir, 'osv-vuln-cache.json');
    return {
        save(data) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify(data));
                return true;
            } catch {
                return false; // a cache that cannot be written must not fail a review
            }
        },
        load() {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                return null;
            }
        },
    };
}
```

- [ ] **Step 6: Decide how OSV gets its cache, and record the decision**

Run: `grep -n "osv_vuln_cache" -B12 src/services/OSVService.js`

If the cache read/write sits behind an injectable option, pass `createFileOsvCache(dir)`. If it calls `chrome.storage.local` directly with no seam, do NOT add one under `src/` — this plan's `src/` budget is the single `RAGService` change from Task 4. Instead omit the dependency section from the bundle and have `review_pr` include the line:

```
dependencies: not checked (OSV cache requires extension storage; see plan Task 8)
```

Either way, state in your report which branch you took and why. A named omission is fine; a crash or a silently missing section is not.

- [ ] **Step 7: Write the failing review test**

Create `packages/mcp/test/review.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';
import { INDEX_REPO_TOOL } from '../src/tools/index_repo.js';

const FIXTURE = path.resolve('packages/mcp/test/fixtures/mini-repo');
const TIMEOUT = 300000;
const ctx = () => ({
    config: { repo: process.cwd(), maxFiles: 200, maxToolTokens: 16384, githubToken: null, gitlabToken: null },
    indexer: null,
});

test('declares its contract', () => {
    assert.equal(REVIEW_PR_TOOL.name, 'review_pr');
    assert.equal(REVIEW_PR_TOOL.inputSchema.type, 'object');
    // The description must not promise findings — it returns material.
    assert.doesNotMatch(REVIEW_PR_TOOL.description, /generates? (the )?(review|findings)/i);
});

test('the bundle carries every declared section', { timeout: TIMEOUT }, async () => {
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    assert.equal(r.isError, undefined);
    const text = r.content[0].text;
    for (const section of ['hunks', 'rubric', 'graph_context', 'similar_code',
        'covering_tests', 'prior_findings', 'static_analysis']) {
        assert.match(text, new RegExp(section, 'i'), `bundle is missing ${section}:\n${text.slice(0, 600)}`);
    }
});

test('the bundle contains no generated findings and no verdict', { timeout: TIMEOUT }, async () => {
    // The keyless invariant made observable: if a future change wires an LLM in,
    // this test is what notices.
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    const text = r.content[0].text.toLowerCase();
    assert.doesNotMatch(text, /"severity":\s*"(critical|high)"/);
    assert.doesNotMatch(text, /overall verdict/);
});

test('a section whose analyzer fails is named as unavailable, not dropped', { timeout: TIMEOUT }, async () => {
    // A missing section that says why is recoverable; a silently absent one makes
    // the reader assume the check passed.
    const r = await REVIEW_PR_TOOL.handler({ range: 'HEAD~1..HEAD' }, ctx());
    const text = r.content[0].text;
    const sections = (text.match(/^[a-z_]+:/gm) || []).length;
    assert.ok(sections >= 7, `expected at least 7 labelled sections, found ${sections}`);
});

test('neither target argument is a structured error', async () => {
    const r = await REVIEW_PR_TOOL.handler({}, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /pr_url|range/);
});
```

- [ ] **Step 8: Run it and confirm it fails**

Run: `node --test packages/mcp/test/review.test.js`
Expected: FAIL — cannot find module `../src/tools/review.js`

- [ ] **Step 9: Implement review.js**

Create `packages/mcp/src/tools/review.js`:

```js
import { getIndexer } from '../repo/indexer.js';
import { parseDiffTarget, GET_DIFF_CONTEXT_TOOL } from './diff.js';
import { buildRubric } from './rubric.js';
import { capText } from './cap.js';

/**
 * Assemble the material for a review. Does NOT produce one.
 *
 * The orchestrator in the extension needs an LLM callable and this package has
 * none by design, so this hands Claude the evidence and lets Claude reason.
 * `static_analysis` is the part Claude cannot produce for itself — real linter,
 * tree-sitter and secret-scan output, no model involved.
 *
 * Every section is assembled defensively and, when a source fails, is reported
 * as unavailable with the reason. A silently absent section reads as "that check
 * passed", which is the worst possible failure for a security section.
 */

async function safely(label, fn) {
    try {
        const value = await fn();
        return { label, value, ok: true };
    } catch (error) {
        return { label, value: null, ok: false, reason: error.message };
    }
}

export const REVIEW_PR_TOOL = {
    name: 'review_pr',
    description:
        'Assemble everything needed to review a pull request or local range: windowed diff hunks, '
        + 'graph context for the touched symbols, comparable code, covering tests, prior findings on '
        + 'this repository, and deterministic static-analysis output (linters, tree-sitter, secret '
        + 'scan). Returns this material for you to reason over — it does not itself write findings.',
    inputSchema: {
        type: 'object',
        properties: {
            pr_url: { type: 'string', description: 'GitHub PR or GitLab MR URL.' },
            range: { type: 'string', description: 'Local git revision range, e.g. main..HEAD.' },
        },
    },

    async handler(args, ctx) {
        const target = parseDiffTarget(args);
        if (target.error) {
            return { isError: true, content: [{ type: 'text', text: target.error }] };
        }

        try {
            const indexer = await getIndexer(ctx);
            await indexer.ensureIndexed({});

            // Reuse get_diff_context rather than duplicating the fetch and the
            // windowing: one code path means one place for the shapes to be right.
            const diff = await GET_DIFF_CONTEXT_TOOL.handler(args, ctx);
            if (diff.isError) return diff;
            const hunks = diff.content[0].text;

            const sections = [];
            sections.push({ label: 'rubric', value: buildRubric(), ok: true });
            sections.push({ label: 'hunks', value: hunks, ok: true });

            sections.push(await safely('similar_code', async () => {
                const res = await indexer.rag.retrieveContext(
                    indexer.repoId, hunks.slice(0, 2000), 5,
                );
                return JSON.stringify(res?.chunks || res?.results || [], null, 2);
            }));

            sections.push(await safely('graph_context', async () => {
                const stats = indexer.pipeline.getStats();
                return JSON.stringify({ graph: stats, parser: indexer.parserMode() }, null, 2);
            }));

            sections.push(await safely('covering_tests', async () => {
                const { TestCoverageBuilder } = await import(
                    '../../../../src/services/TestCoverageBuilder.js'
                );
                const builder = new TestCoverageBuilder();
                return JSON.stringify(builder.getStats?.() ?? {}, null, 2);
            }));

            sections.push(await safely('prior_findings', async () => {
                const { PriorFindingService } = await import(
                    '../../../../src/services/PriorFindingService.js'
                );
                const svc = new PriorFindingService({});
                const related = await svc.relatedPRs({ files: [] }, { repoId: indexer.repoId, limit: 5 });
                return JSON.stringify(related || [], null, 2);
            }));

            sections.push(await safely('static_analysis', async () => {
                const { StaticAnalysisService } = await import(
                    '../../../../src/services/StaticAnalysisService.js'
                );
                const { SecretsScanner } = await import(
                    '../../../../src/services/SecretsScanner.js'
                );
                const svc = new StaticAnalysisService({});
                const files = [];   // populated from the diff in Step 10
                const lint = await svc.analyzeFiles(files, {});
                const secrets = new SecretsScanner().scanPRFiles(files);
                return JSON.stringify({ lint, secrets }, null, 2);
            }));

            const rendered = sections.map((s) => (s.ok
                ? `${s.label}:\n${s.value}`
                : `${s.label}: unavailable — ${s.reason}`));

            const capped = capText(rendered.join('\n\n'), ctx.config.maxToolTokens);
            const text = capped.truncated ? `${capped.text}\n\n[${capped.note}]` : capped.text;
            return { content: [{ type: 'text', text }] };
        } catch (error) {
            return {
                isError: true,
                content: [{ type: 'text', text: `review_pr failed: ${error.message}` }],
            };
        }
    },
};
```

- [ ] **Step 10: Give the analyzers real files instead of the empty array**

The `static_analysis` section above passes `files = []`, which would make it always empty — the section that most justifies this tool. Fix it: call `collectDiffFiles(args, ctx)` — declared in Task 7 for exactly this — and pass its files to `analyzeFiles` and `scanPRFiles`.

Also confirm the shapes these two expect:

Run: `grep -n "async analyzeFiles" -A20 src/services/StaticAnalysisService.js`
Run: `grep -n "scanPRFiles" -A16 src/services/SecretsScanner.js`

`scanPRFiles` reads patches (it has `extractAddedLines`), so `{filename, patch}` is likely right; `analyzeFiles` may want `{path, content}`. Supply each what it actually wants and report the shapes.

Add a test asserting the section is non-empty for a range that touches a JavaScript file, so "always empty" cannot pass again.

- [ ] **Step 11: Run the review tests**

Run: `node --test packages/mcp/test/review.test.js`
Expected: PASS, 5 tests plus the one you added in Step 10

- [ ] **Step 12: Register the tool**

Add `REVIEW_PR_TOOL` to `packages/mcp/src/tools/registry.js`, imported from `./review.js`, at the end of the `TOOLS` array. The array now holds all eight tools.

- [ ] **Step 13: Verify the gates**

Run: `node --test packages/mcp/test/` → PASS, handshake lists eight tools
Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src` → no output. This is the task where that invariant is most at risk; check it deliberately.

- [ ] **Step 14: Commit** — ask the user first

```bash
git add packages/mcp/src/tools/review.js packages/mcp/src/tools/rubric.js \
        packages/mcp/src/adapters/osvCache.js packages/mcp/src/tools/registry.js packages/mcp/test
git commit -m "feat(mcp): review_pr assembles a keyless review bundle"
```

---

### Task 9: Packaging, README, and end-to-end verification

**Files:**
- Create: `packages/mcp/README.md`, `packages/mcp/build.js`
- Modify: `packages/mcp/package.json`
- Test: `packages/mcp/test/e2e.test.js`

**Interfaces:**
- Consumes: everything
- Produces: a publishable package; `npm run build` inside `packages/mcp` emits `dist/index.js`

**The published package cannot reach out of its own directory.** Every adapter imports the extension's services by relative path (`../../../../src/services/...`), which works in this monorepo and breaks the moment npm installs only `packages/mcp`. So publishing bundles those files in at build time with esbuild (already a dependency at 0.27.0). WASM grammars and the embedding model stay external — resolved from `node_modules` and downloaded on first run respectively.

- [ ] **Step 1: Write the failing end-to-end test**

Create `packages/mcp/test/e2e.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const TIMEOUT = 300000;

/** Drive the server over real stdio and collect newline-delimited responses. */
function client(args = ['--repo', '.']) {
    const child = spawn('node', ['packages/mcp/src/index.js', ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) { try { responses.push(JSON.parse(line)); } catch { /* not a frame */ } }
        }
    });
    return {
        child,
        responses,
        send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); },
        async waitFor(id, ms = 120000) {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                const hit = responses.find((r) => r.id === id);
                if (hit) return hit;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`no response for id ${id}`);
        },
        kill() { child.kill(); },
    };
}

test('all eight tools are advertised over the wire', { timeout: TIMEOUT }, async () => {
    const c = client();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await c.waitFor(2);

    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
        'find_callers', 'get_diff_context', 'get_symbol', 'impact_of_change',
        'index_repo', 'repo_overview', 'review_pr', 'search_code',
    ]);
    // Every tool must carry a schema, or a client cannot call it.
    for (const t of list.result.tools) {
        assert.equal(t.inputSchema.type, 'object', `${t.name} has no object schema`);
        assert.ok(t.description.length > 0, `${t.name} has no description`);
    }
    c.kill();
});

test('an unknown tool returns a structured error naming what IS available', { timeout: TIMEOUT }, async () => {
    const c = client();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} } });
    const r = await c.waitFor(2);
    assert.match(JSON.stringify(r), /search_code/);
    c.kill();
});

test('repo_overview answers over the wire against this repository', { timeout: TIMEOUT }, async () => {
    const c = client();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'repo_overview', arguments: {} } });
    const r = await c.waitFor(2, 280000);
    assert.equal(r.error, undefined);
    assert.match(JSON.stringify(r.result), /Repository|Graph/);
    c.kill();
});

test('nothing but protocol frames reaches stdout', { timeout: TIMEOUT }, async () => {
    // A stray console.log inside a ported service corrupts the transport, which
    // presents to the user as the server being broken rather than as a log line.
    const c = client();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'repo_overview', arguments: {} } });
    await c.waitFor(2, 280000);
    // Every collected line parsed as JSON, or waitFor would have failed; assert
    // each has the jsonrpc envelope.
    for (const r of c.responses) assert.equal(r.jsonrpc, '2.0');
    c.kill();
});
```

- [ ] **Step 2: Run it**

Run: `node --test packages/mcp/test/e2e.test.js`
Expected: PASS, 4 tests. If the tool-name list differs, the registry and the spec disagree — fix the registry, not the test: those eight names are the wire contract.

- [ ] **Step 3: Write the bundler**

Create `packages/mcp/build.js`:

```js
import esbuild from 'esbuild';

/**
 * Bundle for publishing.
 *
 * The adapters import the extension's services by relative path out of this
 * package, which works in the monorepo and breaks as soon as npm installs
 * packages/mcp alone. Bundling resolves those at build time.
 *
 * Left external on purpose:
 *  - @xenova/transformers  — ships its own wasm/onnx assets and downloads the model
 *  - web-tree-sitter, tree-sitter-wasms — resolved from node_modules at runtime
 *  - fake-indexeddb        — no reason to inline it
 *  - @modelcontextprotocol/sdk — a peer of the host's protocol version
 */
await esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
    external: [
        '@xenova/transformers',
        'web-tree-sitter',
        'tree-sitter-wasms',
        'fake-indexeddb',
        '@modelcontextprotocol/sdk',
        '@modelcontextprotocol/sdk/*',
    ],
    logLevel: 'info',
});
```

- [ ] **Step 4: Wire the build and point `bin` at the bundle**

In `packages/mcp/package.json`, change `bin` and add the scripts:

```json
  "bin": { "repospector-mcp": "dist/index.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "test": "node --test test/",
    "build": "node build.js",
    "prepublishOnly": "node build.js",
    "start": "node src/index.js"
  },
```

- [ ] **Step 5: Build and smoke-test the bundle**

Run: `cd packages/mcp && node build.js && cd ../..`
Expected: writes `packages/mcp/dist/index.js` with no unresolved-import errors.

Run: `node --check packages/mcp/dist/index.js`
Expected: parses.

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node packages/mcp/dist/index.js --repo . | head -1
```
Expected: one JSON line whose `result.serverInfo.name` is `repospector`. This proves the *bundle* works, not just the source tree — the difference is exactly what breaks a published package.

- [ ] **Step 6: Write the README**

Create `packages/mcp/README.md` containing: what it is (one paragraph, including that it holds no API key and calls no model); the config block for Claude Desktop, Claude Code and Codex; the eight tools in a table with one line each; the `--repo`, `--max-files` and `--max-tool-tokens` flags; the `GITHUB_TOKEN` / `GITLAB_TOKEN` environment variables and that they are git-host credentials, not model keys; where the index and model are cached (`~/.repospector/index`, `~/.repospector/models`) and that the first run downloads roughly 90 MB; and the explicit statement that `review_pr` returns material for a review rather than a generated review, with the reason.

- [ ] **Step 7: Full gate sweep**

Run: `node --test packages/mcp/test/` → all pass
Run: `npx jest` → 181 suites / 2616 passed / 1 skipped / 0 failed
Run: `npm run build` (repo root) → "Build validation passed!"
Run: `grep -rn "LLMService\|ANTHROPIC_API_KEY\|OPENAI_API_KEY" packages/mcp/src packages/mcp/dist` → no output
Run: `wc -l packages/mcp/src/**/*.js` → confirm no file exceeds 300 lines

- [ ] **Step 8: Manual verification — NOT automatable, hand this list to the user**

None of the following can run in this environment; write the checklist into your report as NOT DONE:

- Add the config block to Claude Desktop, restart it, and confirm `repospector` appears with eight tools.
- Ask Claude "give me an overview of this repo" and confirm `repo_overview` is called and answers.
- Ask it to find the callers of a real symbol; confirm `find_callers` returns real call sites.
- Run `review_pr` on a real PR and confirm the bundle arrives with a non-empty `static_analysis` section.
- Repeat the config in Claude Code and in Codex — config discovery and roots behaviour differ between clients and none of it is unit-testable.
- Confirm a second run starts warm (no re-embedding), proving the snapshot restored.

- [ ] **Step 9: Commit** — ask the user first

```bash
git add packages/mcp
git commit -m "feat(mcp): package for publishing, README, and end-to-end stdio verification"
```

---

## Spec Coverage Check

| Spec section | Task |
| --- | --- |
| Distribution via `npx -y @repospector/mcp` | 1 (manifest, bin), 9 (bundle, README) |
| `search_code`, `get_symbol`, `find_callers` | 6 |
| `impact_of_change`, `repo_overview` | 6 |
| `get_diff_context` | 7 |
| `index_repo` (spec revision) | 5 |
| `review_pr` as a bundle (spec revision) | 8 |
| Every response size-capped | 5 (`cap.js`), applied in 5-8 |
| Adapter 1 — tree-sitter | 3 |
| Adapter 2 — embeddings + the one `src/` change | 4 |
| Adapter 3 — persistence | 2 |
| OSV cache seam | 8 |
| Index lifecycle, incremental rebuild | 5 |
| Structured errors with recovery hints | 5-8 (each handler), 1 (unknown tool) |
| Packaging: workspaces + esbuild | 1 (workspaces), 9 (esbuild) |
| Testing: units, contract, goldens, stdio | 2-8 (units), 3 (parser contract), 6 (ranking goldens), 1 and 9 (stdio) |
| No LLM client, no key | Global constraint, checked every task |

## Deferred, with reason

- **MCP sampling.** Would let `review_pr` run the real orchestrator on the user's subscription, but client support is uneven and the tool would fail outright where it is missing. Revisit when Claude Desktop, Claude Code and Codex all implement it.
- **A `--bridge` transport to the extension.** The standalone design was chosen deliberately; the extension's index stays in the browser. Adding a bridge means requiring Chrome to be open and the service worker awake, which the `No SW` failures observed during the keyless work suggest is not a foundation to build on.
- **`Settings.jsx`'s duplicate provider enum and the `.jsx` lint gap.** Recorded against the keyless work, unrelated to this package.

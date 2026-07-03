# 🛡️ RepoSpector — AI Code Review for GitHub & GitLab

RepoSpector is a Manifest V3 Chrome extension that brings an AI reviewer to your
pull/merge requests. It reviews diffs, chats with your codebase, runs static
analysis, and generates unit tests — using your own API key for any of several
LLM providers, with local embeddings that keep indexing on your machine.

> **Note:** RepoSpector began life as a unit-test generator. It is now a full
> code-review assistant; test generation is one feature among several.

## ✨ Features

### PR / MR review
- **Two-phase review pipeline** — skip-rule gating (docs-only, draft, oversized)
  → diff chunking → per-file deep LLM review → static-analysis merge →
  assigned-hunks normalization → a canonical verdict report.
- **Inline finding threads** — explain a finding, ask for a fix, or post an
  inline comment back to GitHub/GitLab.
- **Persistent sessions** — reviews, threads, and metrics are stored in
  IndexedDB with a 30-day retention window.
- **Adaptive learning** — records which findings you act on to tune future noise.

### Codebase chat with RAG
- **Hybrid retrieval** combining a BM25 keyword index and an HNSW vector index.
- **Local embeddings** via `@xenova/transformers` running in an MV3 offscreen
  document — model weights and the ONNX WASM runtime are bundled, so indexing
  works offline and nothing leaves your machine.
- **Incremental indexing** — a hash-diff manifest re-embeds only changed chunks.

### Static analysis
- ESLint and Semgrep-style pattern checks, secret scanning, dependency
  vulnerability checks against [OSV](https://osv.dev), and end-of-life detection
  via [endoflife.date](https://endoflife.date).
- A confidence scorer fuses overlapping findings and suppresses low-signal noise.

### Test generation
- Generates Unit, Integration, E2E, or comprehensive tests with coverage
  tracking, edge-case analysis, and syntax/quality gates.

### Code knowledge graph
- Tree-sitter parsing (also in the offscreen document), symbol extraction, a
  call graph, `TESTED_BY` coverage edges, and change-impact analysis.

### Multi-provider, bring-your-own-key
- OpenAI, Anthropic, Google, Groq, Mistral, HuggingFace, and local models
  (Ollama). Keys are stored encrypted (AES-GCM with PBKDF2 key derivation).

## 🚀 Installation

### From source (development)

```bash
# Replace with your fork/clone URL.
git clone https://github.com/<your-org>/repospector.git
cd repospector
npm install
npm run build      # builds CSS + the isolated extension bundle into dist/
```

Then load it in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` directory

### Configure a provider

1. Click the RepoSpector icon, then the settings gear.
2. Choose a provider and paste your API key (e.g. OpenAI keys start with `sk-`).
   For local models, point at your Ollama server (`http://localhost:11434`).
3. Save. Keys are encrypted before they touch storage.

## 📖 Usage

- **Review a PR/MR:** open a pull/merge request on GitHub or GitLab and use the
  RepoSpector panel to run a review. Findings appear inline and in the panel;
  open a thread on any finding to ask for an explanation or a fix.
- **Chat with the codebase:** index a repository, then ask questions — retrieval
  pulls the most relevant code (vector + keyword) into the prompt.
- **Static analysis:** run it standalone or as part of a PR review; results are
  merged and confidence-scored alongside the LLM findings.
- **Generate tests:** select code or a file and choose a test type and context
  level (Minimal / Smart / Full).

### Supported platforms

GitHub, GitLab, Bitbucket, Azure DevOps, SourceForge, Codeberg, Gitea,
SourceHut, and Pagure (see `src/manifest.json` for the exact matched origins).

## 🏗️ Architecture

```
┌─ popup (React) ──────────────┐        ┌─ content script ─────────────┐
│ PR review UI, chat, settings │◀──────▶│ diff extraction + inline     │
└──────────────┬───────────────┘        │ overlays on git platforms    │
               │ chrome.runtime          └──────────────┬───────────────┘
               ▼ messages                                │
┌─ background service worker ──────────────────────────▼─┐
│ messageRouter.dispatch → per-domain handlers            │
│ review · chat/RAG · static analysis · test-gen · docs   │
└──────────────┬───────────────────────────┬─────────────┘
               │                            │ (WASM/ML can't run in a SW)
               ▼                            ▼
┌─ services ───────────────┐   ┌─ offscreen document ─────┐
│ ReviewOrchestrator,      │   │ transformers.js embeddings│
│ MultiPassReviewEngine,   │   │ + tree-sitter parsing     │
│ RAG (BM25 + HNSW), ...   │   └───────────────────────────┘
└──────────────────────────┘
```

- **`@repospector/review-core`** (`packages/review-core`) holds the shared review
  orchestration (schema, skip rules, chunker, normalizer, orchestrator) so the
  extension and the backend stay in sync.
- **Aegis backend** (`apps/api`) is an optional Express + Postgres + Redis/BullMQ
  service for what an extension can't do — real `git clone`, cross-repo analysis,
  webhook-triggered reviews, and metered billing. It is disabled in the shipped
  extension; see `docs/adr/0001-backend-service.md`.

## 🧪 Testing

```bash
npm test              # Jest unit + integration suite
npm run test:coverage # with coverage
npm run lint          # ESLint
npm run validate      # lint + test
```

Tests exercise real modules (see `test/unit/` and `test/integration/`). The
harness (`test/setup.js`) provides Chrome API mocks plus a real WebCrypto and
URL implementation so encryption and URL-parsing code runs for real.

## 🔧 Development

```
src/
├── background/       # service worker: index.js + messageRouter.js
├── content/          # content script, diff overlays, code extraction
├── offscreen/        # WASM/ML host (embeddings + tree-sitter)
├── popup/            # React UI (components, hooks)
├── services/         # review, RAG, static analysis, graph, LLM, storage
├── utils/            # sanitizer, chunking, diff parser, languageMap, prompts
└── manifest.json
packages/review-core/ # shared review orchestration (extension + backend)
apps/api/             # Aegis backend (optional, disabled in the extension)
```

Build: `npm run build` runs `build:css` then `build-isolated.js` to produce
`dist/`. `npm run package` zips `dist/` for the Chrome Web Store.

## 🔒 Security

- API keys and tokens are encrypted at rest (AES-GCM + PBKDF2).
- Host permissions are limited to the supported git platforms, the configured
  LLM provider endpoints, OSV, and endoflife.date; web-accessible resources are
  scoped to the git-platform origins rather than all URLs.
- Local embeddings avoid sending your code to a third-party embedding service.

## 📄 License

See `LICENSE`.

---

**RepoSpector** — AI code review, codebase chat, static analysis, and test
generation for GitHub & GitLab.

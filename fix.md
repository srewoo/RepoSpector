# RepoSpector — Fixes & Improvements Plan

A working document tracking everything that has shipped and everything still
queued. Use this to hand off context between sessions or to scope follow-up
PRs. Last updated: 2026-04-28.

---

## Status legend

- ✅ **Shipped** — landed on `main`, has tests and a build-green commit
- 🟡 **Partial** — core piece shipped, integration or polish deferred
- ⏸ **Deferred** — scoped, sized, deliberately not started this session
- 🔍 **Backlog** — uncovered during work, not yet sized

---

## 1. What has shipped

### Phase 1 — Spine + Security ✅

| Task | Notes |
|---|---|
| Tighten manifest permissions | `host_permissions` narrowed from `https://*/*` to specific VCS+API hosts. Broad access moved to `optional_host_permissions` so users can opt-in for self-hosted GitLab/Gitea. |
| Typed message router with origin validation | `src/background/messageRouter.js` — registry pattern; rejects messages from foreign extensions (`sender.id !== chrome.runtime.id`); rejects content-script messages from origins outside the allow-list; per-handler `allowContentScript` flag. |
| Wire router into `background/index.js` | Replaced both the 54-case `BackgroundService.handleMessage` switch AND the outer fallthrough switch with a single `dispatch()` call. ~350 lines deleted, registry table added. |
| Router unit tests | 13 tests: origin validation, unknown types, content-script gating, error propagation, popup-relay edge case. |
| GitHub Actions CI + bundle budget | `.github/workflows/ci.yml`: lint + test + build + `scripts/check-bundle-size.cjs`. Budgets: SW 1.5 MB, content 250 KB, popup 8 MB (lower as Phase 4 progresses). |

### Phase 2 — Native PR-page integration ✅

| Task | Notes |
|---|---|
| PR diff overlays | `src/content/diffOverlay.js` — per-file action bar (`🔍 Explain · 💡 Suggest fix · 💬 Comment`) injected on github.com and gitlab.com PR/MR pages. Plain DOM + scoped `rs-overlay-*` CSS (inlined as a JS string since rollup doesn't bundle `.css` for the content script). MutationObserver re-injects on SPA navigation. |
| Keyboard navigation | `j` / `k` next/prev hunk, `e` Explain, `f` Suggest fix, `c` Comment. Skips when focus is in an editable. |
| Three new content-script handlers | `EXPLAIN_HUNK`, `SUGGEST_FIX_HUNK`, `POST_INLINE_COMMENT` — all registered with `allowContentScript: true`. |
| Post review back to GitHub/GitLab | Already implemented in `PullRequestService.postReview`: GitHub Pull Request Reviews API + GitLab MR diff notes. UI button + settings toggle exist (`Settings → enablePRComments`). |

### Phase 3 — Review quality ✅

| Task | Notes |
|---|---|
| Diff-anchored review prompts | `PR_ANALYSIS_SYSTEM_PROMPT` and `buildSecurityReviewPrompt` now include a mandatory "DIFF-ANCHORED REVIEW" section forbidding findings on context lines. Drops the #1 source of AI-review noise: re-litigated pre-existing issues. |
| Incremental review cache | `src/services/FindingCache.js` — chrome.storage-backed, partitioned per (platform, owner, repo, prNumber), keyed by `${file}::${hunkHash}`. Hunk hash is FNV-1a 32-bit over whitespace-normalized text. 30-day TTL. 13 unit tests. Three new handlers: `LOOKUP_FINDING_CACHE`, `PUT_FINDING_CACHE`, `CLEAR_FINDING_CACHE`. |
| Adaptive learning feedback loop | `AdaptiveLearningService.getDismissedRulesSummary(repoId, limit)` groups dismissals by ruleId, filters above `dismissalThreshold`, returns top-N with sample messages. `buildPRAnalysisPrompt` accepts `dismissedRules` and renders a "Repo Reviewer Preferences" section near the top of the prompt. The model deprioritises (does not suppress) those patterns. 4 unit tests. |

### Phase 4 — Bundle / lazy-load 🟡

| Task | Status | Notes |
|---|---|---|
| Lazy-load mermaid + react-zoom-pan-pinch | ✅ | `MermaidDiagram` lazy-loads `mermaid` + zoom/pan via dynamic imports. Both consumers (`ChatInterface`, `PRReviewInterface`) wrap it in `React.lazy` + `Suspense`. **Popup 6.83 MB → 6.29 MB.** Per-diagram chunks (cytoscape 442 KB, treemap 375 KB, katex 265 KB, sequence/architecture/...) are now loaded on demand. |
| Split popup mega-components | ⏸ | Deferred — see §2. |
| Split background/index.js | ⏸ | Deferred — see §2. |

### Phase 5 — Quality (foundations only) 🟡

| Task | Status | Notes |
|---|---|---|
| Test coverage for retrieval/review services | ⏸ | Deferred — see §2. |
| TS strict migration of `services/` | ⏸ | Deferred — see §2. |

### Phase 6 — Repo config + telemetry ✅

| Task | Notes |
|---|---|
| `.repospector.yaml` schema extended | New `settings.severityThreshold` (drops below floor), `settings.model` (pin `<provider>:<model>` per repo), `settings.diffAnchored` (default true). `applyAllRules` now applies the severity threshold after ignores/overrides/min-confidence. |
| `handleAnalyzePullRequest` honours model pin | Logs `🎯 Using model pinned by .repospector.yaml: <model>` when the repo overrides the user setting. |
| `docs/repospector-config.md` | Full schema doc with per-layer precedence table. |
| `TelemetryService` (opt-in, local-only) | `src/services/TelemetryService.js` — chrome.storage-backed rolling window of 200 runs. Tracks duration, token in/out, cost USD, findingsTotal/Kept/Dismissed, kind, model. p50/p95 nearest-rank, FP-rate proxy = dismissed / kept (clipped to [0,1]). 8 unit tests. Strict no-op until `setEnabled(true)`. |
| Telemetry wired into the analyze path | Every PR review records a run; every dismissal bumps the most-recent `pr_review` run's `dismissed` counter. Errors swallowed — telemetry never breaks a review. |
| Three telemetry handlers | `GET_TELEMETRY`, `SET_TELEMETRY_ENABLED`, `CLEAR_TELEMETRY`. |

### Hotfixes ✅

| Task | Notes |
|---|---|
| Floating-panel popup relay rejected by router | Origin gate added in Phase 1 was rejecting popup-relay messages (the floating panel renders the popup React app inside a host page and relays via `chrome.runtime.sendMessage` with `isFromPopup: true`). Reported on `gitlab.com/mindtickle/...` as "Failed to load settings" at popup.js:372. Fix: `validateSender` now treats `isFromPopup: true` as bypassing the per-handler `allowContentScript` gate, while still enforcing the origin allow-list so a malicious page can't escalate. 2 new router tests cover both branches. |
| AES master key rotating on DST / Chrome updates | User saw "AES decryption failed: [object DOMException]" after the extension had been working. The PBKDF2 fingerprint feeding the master key included `Date.getTimezoneOffset()` (flips twice a year), `navigator.userAgent` (every Chrome auto-update), `screen.*` (any monitor change), and Canvas/WebGL (different in DOM vs SW). Any of those changing silently invalidated every stored credential. Fix: stabilized the fingerprint to `{platform, language, version-tag}` with the 32-byte salt providing entropy; bumped `keyVersion` to 3 with a one-time migration warning; downgraded the noisy `console.error` to a `console.warn` with an actionable "re-enter your API keys" message; made `getStoredSettings` self-heal by deleting unreadable ciphertext from storage so the failure stops repeating. |

### Phase 1 follow-ups ✅

| Task | Notes |
|---|---|
| Clear pre-existing lint debt | 114 → 0 errors. Added `scripts/fix-lint.cjs` (parses eslint JSON, applies safe column-precise fixes for `no-useless-escape` and `no-unused-vars`). Tightened eslint config: `varsIgnorePattern: '^_'`, `caughtErrorsIgnorePattern: '^_'`. Manual: 4 SSE `while (true)` loops disabled inline; 1 `case` block wrapped; deleted 4 dead writes. CI lint dropped `continue-on-error` and now uses `--max-warnings 10`. |
| Fix conversationHistory pruning over budget | Pruner used to skip oversize messages but keep walking, letting smaller older messages sneak past the budget. Now breaks on first overflow. Made `MAX_CONTEXT_TOKENS` overridable via `new ConversationHistoryManager({ maxContextTokens })` so the test exercises pruning with an 8K budget instead of generating 32K of text. Re-enabled the previously skipped test. |

### Aggregate metrics across all sessions

| | Before | After | Δ |
|---|---|---|---|
| Tests passing | 238 | **270** | +32 |
| Tests skipped | 1 | **0** | −1 |
| Tests failing | 1 (pre-existing) | **0** | −1 |
| Lint errors | 114 | **0** | −114 |
| Popup bundle | 6.83 MB | **6.29 MB** | −540 KB |
| Background SW LOC dispatch logic | 354 lines (two switches) | **~70 lines registry** | −284 |
| `host_permissions` scope | `https://*/*` | **20 specific hosts** | + opt-in for arbitrary |

---

## 2. What's still planned (deferred deliberately)

These are real engineering work and should be their own reviewable PRs.
Crammed-in attempts in a single auto-mode session would risk silent breakage.

### #11 — Split `background/index.js` into feature modules ⏸

**Effort:** ~1 week. **Risk:** medium (lots of shared state).

Goal: turn the 5,500-line `BackgroundService` god-object into one module per
bounded context, each <500 LOC, each owning its own handler registration.

Proposed layout:

```
src/background/
├── core/
│   ├── bootstrap.ts         // service instantiation + lifecycle
│   └── messageRouter.js     // (already exists, stays)
├── features/
│   ├── pr-review/
│   │   ├── handlers.ts      // ANALYZE_PULL_REQUEST, GET_PR_SUMMARY, ...
│   │   ├── prompts.ts
│   │   └── index.ts         // registers handlers with the router
│   ├── rag/
│   │   ├── handlers.ts      // INIT_RAG, INDEX_REPO, RETRIEVE_CONTEXT, ...
│   │   └── index.ts
│   ├── threads/             // CREATE_PR_THREAD, SEND_THREAD_MESSAGE, ...
│   ├── test-gen/            // GENERATE_TESTS, CHAT_WITH_CODE
│   ├── settings/            // SAVE_SETTINGS, GET_SETTINGS, VALIDATE_API_KEY
│   ├── repo-info/           // GENERATE_REPO_INFO, GENERATE_REPO_DIAGRAM, ...
│   ├── learning/            // RECORD_FINDING_ACTION, GET_LEARNING_STATS
│   └── telemetry/           // GET_TELEMETRY, SET_TELEMETRY_ENABLED, ...
└── index.js                 // imports all features → ~200 LOC
```

Plan:
1. Extract one feature at a time, smallest first (`telemetry` → 3 handlers).
2. Each extraction: move handler bodies + their helpers, register from the
   feature's `index.ts`, delete from `BackgroundService`.
3. After each extraction: full build + test + manual smoke on a real PR.
4. Last to leave `BackgroundService`: shared dependencies (RAG, LLMService).

Risks:
- Hidden coupling via `this.contextAnalyzer.setRagService(...)` style cross-
  service mutation. Audit every reference to `this.<service>` first.
- Service-worker cold-start: ensure registration imports are still eager so
  no message arrives before its handler is registered.

### #12 — Split popup mega-components ⏸

**Effort:** 2–4 days. **Risk:** low–medium (UI regressions).

Targets, by current size:

| File | LOC | Target |
|---|---|---|
| `src/popup/components/ChatInterface.jsx` | 1,662 | <300 per file |
| `src/popup/components/PRReviewInterface.jsx` | 1,083 | <300 per file |
| `src/popup/components/Settings.jsx` | 717 | <300 per file |
| `src/popup/components/StaticAnalysisResults.jsx` | 441 | <300 |
| `src/popup/components/ReposView.jsx` | 410 | <300 |

Approach:
1. **Extract data hooks** first (`usePRReview`, `useChatHistory`,
   `useSettings`) — pulling state/effects out of components is the single
   biggest readability win.
2. Then extract presentational subcomponents (`MessageBubble`,
   `FindingsList`, `RepoSelector`, etc.) — pure, prop-driven, easy to unit
   test.
3. Lift orchestration into a thin "page" component that composes them.

Wins:
- Each subcomponent is a separate React.lazy boundary, eligible for code-
  splitting like Mermaid was. Could push the popup bundle below 2 MB.
- Independently testable (RTL).
- Multiple devs can work on review UI without conflicts.

### #13a — Lazy-load framer-motion 🔍

**Effort:** ~1 day. **Risk:** medium (animations everywhere).

`framer-motion` is used across 7+ components. Pure lazy-loading won't help
because it's needed on first paint. Options:

- Replace simple `motion.div` fade/slide with CSS transitions (cheap, fast).
- Keep `framer-motion` only for layout animations and complex sequences;
  introduce a `<MotionDiv>` wrapper that lazy-loads on first interaction.

Estimated saving: 200–400 KB off the popup bundle.

### #14 — TypeScript strict migration of `services/` ⏸

**Effort:** 3–6 weeks for the full 17K LOC. **Risk:** medium.

`tsconfig.json` already exists; the cost is paid in bundle size already.
Migration unlocks:

- Catching latent bugs in 17K LOC of business logic
- `zod` schemas at the extension boundary (the message router is the
  natural enforcement point)
- Better IDE refactoring confidence for the splits in #11/#12

Sequencing:

1. **Per-service migration**, smallest first. Order by dependents:
   `BM25Index`, `HNSWIndex`, `VectorStore`, `EmbeddingService`,
   `BM25Store`, `HNSWStore`, `IndexManifest`, `RelevanceScorer`,
   `HybridSearcher`, `RAGService` → then platform services (`GitHub`,
   `GitLab`) → then composers (`PullRequestService`,
   `MultiPassReviewEngine`).
2. **Add zod schemas** for every message handler payload at the router. This
   is the single most valuable type addition — it's the system boundary.
3. Defer CSS/UI to a separate pass.

Don't:
- Do not big-bang convert in a single PR.
- Do not introduce `any` to "just get it compiling" — that defeats the
  purpose. Use `unknown` + narrowing.

### #15 — Test coverage for retrieval + review services ⏸

**Effort:** ~1 week. **Risk:** low.

Currently zero tests for: `LLMService`, `RAGService`, `VectorStore`,
`BM25Index`, `HNSWIndex`, `PullRequestService`, `MultiPassReviewEngine`,
`CallGraphBuilder`, `SemgrepAnalyzer`, `SecretsScanner`.

Plan:

| Service | Approach |
|---|---|
| `LLMService` | Recorded-fixture contract tests per provider (no live calls). Catches breakage when a provider changes its response shape. |
| `RAGService` / `VectorStore` | Property-test recall against a small fixture corpus. |
| `BM25Index` / `HNSWIndex` | Deterministic in/out tests with hand-crafted docs. |
| `PullRequestService` | Mock `fetch`, snapshot the requests it builds for GitHub & GitLab. |
| `MultiPassReviewEngine` | Snapshot the prompt artifacts it emits, given a fixture diff. |
| `Prompt builders` | Snapshot tests so prompt drift is reviewable in PRs. |

Should follow #14 so the contracts are typed.

### #16a — Surface telemetry in the popup 🔍

**Effort:** 0.5 day.

The handlers exist (`GET_TELEMETRY`, `SET_TELEMETRY_ENABLED`,
`CLEAR_TELEMETRY`). Missing:

- Toggle in `Settings.jsx` ("Local telemetry — opt in")
- A small "Stats" tab in the popup showing p50/p95, runs, cost, FP rate
- "Reset" button wired to `CLEAR_TELEMETRY`

### #16b — Wire `.repospector.yaml` model pin into `MultiPassReviewEngine` 🔍

**Effort:** 0.5 day.

`handleAnalyzePullRequest` honours the model pin. The multi-pass path
(`handleMultiPassPRReview`) does not yet — same `customConfig.settings.model`
needs to be threaded into the engine's per-pass calls.

### #16c — Telemetry: cost estimation 🔍

**Effort:** 0.5 day.

`TelemetryService.record({ costUsd })` is wired but the call-site passes 0.
Add a tiny pricing table per `<provider>:<model>` and compute
`costUsd = tokensIn * inPrice + tokensOut * outPrice` in the analyze path.

### #16d — Periodic alarm to prune `FindingCache` and `AdaptiveLearning` 🔍

**Effort:** 1 hour.

Both have `pruneExpired()` / `cleanup()` methods but nothing schedules them.
Add a `chrome.alarms` daily tick.

### CODEOWNERS-aware finding routing 🔍

Surface the owner for each finding (parsed from `.github/CODEOWNERS` or
`CODEOWNERS`). Useful for very large repos — review comments can be tagged
to the right team.

### Cost: replace KaTeX bundling 🔍

`react-markdown` pulls in KaTeX (265 KB) for math rendering. Code review
output rarely contains math; gate KaTeX behind a setting or remove.

### Lint debt: revisit `--max-warnings 10` → `0` 🔍

There are 4 intentional `console.log` warnings. Either:

- Convert them to `console.warn` (legitimate by current eslint config), or
- Replace with a structured logger and remove `console.*` entirely.

Then drop `--max-warnings 10` to enforce zero warnings.

---

## 3. Known live bugs / risks (uncovered during this work)

### Two-codepath drift: `handleAnalyzePullRequest` vs static-analysis-augmented variant 🔍

There are two PR-analyze paths in `background/index.js` (line 2865 and
~line 3270). Phase 3 + Phase 6 changes were applied to the first one;
the second got `dismissedRules` but **not** the model pin or telemetry
recording. They should converge into a single helper.

### `panelManager` declared but unused at content-script bottom 🔍

Eslint's `varsIgnorePattern` swallows it now (prefixed with `_`), but the
content script still constructs a `FloatingPanelManager` whose only purpose
is its constructor side effects (creating the toggle button). Either
explicitly comment why, or refactor so init is a free function. Same risk:
a future refactor could remove the "unused" var and break the floating
panel.

### Service worker termination + module-scope `ragService` 🔍

`ragService` is held in module scope. When the SW is terminated and respawn
occurs, the variable is `null` again — but indexed data persists. The
re-init message (`INIT_RAG`) must be re-sent by the popup on every cold
start. This is implicit; should be made explicit (auto re-init on first
RAG-needing message).

### `host_permissions` narrowing risk 🔍

We removed `https://*/*` from `host_permissions`. Self-hosted GitLab /
Gitea installs that the user previously could fetch from will now require
`optional_host_permissions` grant. If telemetry shows this is hitting users,
add a one-time prompt during PR analysis when fetch fails with a permission
error.

---

## 4. Sessioning recommendations

**Highest value-per-effort, smallest risk:**

1. #16a (popup telemetry UI) — half a day, immediately user-visible
2. #16d (alarm to prune caches) — 1 hour, prevents quiet storage growth
3. #16c (cost estimation) — half a day, makes telemetry actually useful
4. #13a (lazy-load framer-motion) — 1 day, big bundle win

**Medium effort, big payoff:**

5. #12 (split popup mega-components) — opens the door to React.lazy code-
   splitting for every popup subcomponent
6. #15 (test coverage for retrieval/review) — biggest brand-risk reducer

**Multi-week / project-scale:**

7. #11 (split `background/index.js`) — only worth doing in a dedicated push
8. #14 (TypeScript migration) — its own quarter; pair with #15

---

## 5. Commits, in order

```
fa101f4 Phase 6: .repospector.yaml repo config + opt-in local telemetry
3c49d9d Lint cleanup: 114 errors → 0; CI lint becomes a hard gate
ab5a252 Phase 3: complete AdaptiveLearning feedback loop
77c4f4c Phase 4a: lazy-load mermaid + fix conversationHistory pruning
3372d0e Phase 3: diff-anchored prompts + incremental review cache
435c5d7 Phase 2: native PR-diff overlays (GitHub + GitLab)
39e2b6c Phase 1: spine + security foundation
```

Each commit is individually buildable, tests pass, and ships a coherent
piece of work. Reviewable as separate PRs.

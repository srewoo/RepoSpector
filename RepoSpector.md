# RepoSpector — AI Code Review (Chrome Extension + MCP)

Nov 17, 2026 · @sharaj

## Summary

RepoSpector is a free, open-source AI code reviewer for GitLab and GitHub. It runs in two ways. A Chrome extension works on merge-request and pull-request pages, with users bringing their own key for any of several model providers. A local MCP server does its reasoning with the user's own Claude Code or Codex session, so it needs no key. The target is at least 65% F1 and 85% precision on [Martian's Code Review Bench](https://codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests). That would match or beat the leaderboard figures for Greptile (64.8% F1, 84.1% precision), Cubic (64.2% F1) and Qodo (61.6% F1).

It copies the five things that make those tools accurate: a graph of the whole codebase, narrow specialist agents, a verifier that checks every finding, evidence from running the code, and filtering based on each team's feedback. To go past them it adds proof by failing test, confidence calibrated per model, an audit of agent-written MRs, a review guide for human reviewers, and a release gate on an open evaluation suite. RepoSpector needs no server of its own. Code goes from the git host to the user's browser or machine, and from there only to the model provider the user chose.

The doc has three parts: the PRD (what and why), the TRD (how it is built) and the user flows (who does what, step by step).

## Architecture review

The outline was sound, but twelve gaps would have kept RepoSpector below the top three. Each is now fixed in the PRD, TRD and flows below. The three biggest: Chrome mode could not build a real code graph, MCP mode trusted a prompt to run the pipeline, and runtime checks could run untrusted code on the user's machine.

| # | Finding | Why it matters | Change made |
| --- | --- | --- | --- |
| 1 | Chrome built context from 60 API fetches and host code search | Code search is rate-limited and GitHub's covers only the default branch, so callers get missed and recall falls behind MCP mode | Download the repo archive at the head commit once, build the graph in a browser worker, cache it per commit |
| 2 | In MCP mode the pipeline order lived in a skill prompt | An agent can skip the verify step, and precision collapses | The local server enforces the order: `finalize` refuses until every finding has a verdict from a separate subagent run |
| 3 | Codex may not run parallel subagents | The MCP flow would stall or run unverified | Fallback to sequential passes or separate `codex exec` runs; MCP sampling where the client supports it |
| 4 | Runtime checks ran tests from any MR on the user's machine | Someone else's MR is untrusted code | Local runs only on the user's own branch; other MRs run in a container with no network and no secrets |
| 5 | Thresholds used raw model confidence | Confidence means different things on different models, so bring-your-own-key users get uneven precision | Confidence is calibrated per model and category on the golden set; the threshold is on expected precision |
| 6 | The feedback filter starts empty | New users get full noise until they reject enough comments | Ship a seed pack of common nit types; bootstrap from the repo's past review history |
| 7 | No incremental review | Every push re-reviews everything and repeats comments | Finding fingerprints; review only the new commits; mark fixed findings resolved; skip issues already raised |
| 8 | Six specialists each resend the same context | Cost per MR multiplies | Shared context sent as a cached prompt prefix; risk tiers give trivial MRs a single pass |
| 9 | Large MRs were not handled | Changes beyond the context window get reviewed badly without anyone knowing | The planner splits by change cluster; a coverage report lists what was not reviewed |
| 10 | Golden cases come from public fixes | Models may have seen the fixes in training, and blame-based tracing mislabels some cases | Rolling fresh cases, human check of the held-out split, separate reporting |
| 11 | Injection defence covered only added instructions | Text in an MR could also talk the reviewer out of a real finding | The verifier must cite code to drop a finding; instructions found in MR content are flagged; keys are isolated from page scripts |
| 12 | One accuracy target for every model setup | A low-cost or local model cannot hit 65% F1 | Targets apply to the Best accuracy preset; other presets publish their own scores |

## PRD — Product requirements

### Problem

Coding agents now open more MRs than people can review carefully. Most AI reviewers make this worse with noise: Greptile's own audit found [79% of its early comments were nits](https://greptile.com/blog/make-llms-shut-up). Developers learn to ignore the bot, and the real bugs get through with the nits.

The best commercial tools fixed this, but they are paid SaaS products. They send code to the vendor's servers and choose the model for you. No open option matches their accuracy, lets people use a model they already pay for, and works the same on GitLab and GitHub.

### Goals

- Find real defects with precision and recall at or above the top three tools.
- Post only comments a developer would act on. Every finding carries its reasoning and evidence.
- Free and open source, with no server required: bring your own key in Chrome, or use your Claude Code or Codex session through MCP.
- GitLab (SaaS and self-managed) and GitHub (including Enterprise) from day one.
- Learn each team's standards from their reactions, rules and past reviews.
- Publish accuracy scores for each model setup on an open golden set, so users can choose models based on evidence.

### Non-goals (v1)

- Hosting, reselling or proxying model access.
- Storing users' code or keys on any RepoSpector server.
- Approving or merging MRs on its own.
- Replacing SAST, dependency scanning or linters. RepoSpector reads their output as context.

### Personas

| Persona | Needs | Main surface |
| --- | --- | --- |
| Individual developer / OSS maintainer | Free reviews using their own key; set up in minutes | Chrome extension |
| MR author on a team | Catch bugs before a human reviewer sees the MR; fix them in one click | Chrome extension, MCP |
| Human reviewer / tech lead | A short list of real issues with evidence, not 30 nits | Chrome extension |
| Coding agent (Claude Code, Codex) | A review it can run with the session it already has, in a loop until clean | MCP server |
| QA / quality engineer | Requirement coverage; runtime evidence for risky changes | Chrome extension, MCP |
| Team lead / maintainer of rules | Shared rules and learned feedback that live in the repo | `.RepoSpector/` files, optional sync server |

### Success metrics

| Metric | Definition | Target by 1.2 |
| --- | --- | --- |
| Acted-on precision | Share of posted comments that lead to a code change or a 👍 (from pilot teams and opt-in metrics) | ≥ 85% |
| Recall | Share of known issues caught on the golden set and Martian's offline set | ≥ 55% |
| F1 | Harmonic mean of the two above | ≥ 65% (Best accuracy preset) |
| Comments per MR (median) | Noise measure | ≤ 4 |
| Time to first review | MR opened to findings shown | ≤ 4 min (p50) |
| User's model spend per MR | Provider cost at the Balanced preset; shown before each run | ≤ $0.60 (p50) |
| Setup time | Install to first review | ≤ 5 min |

The F1 and precision targets apply to the Best accuracy preset; every other preset publishes its own score. The 1.0 gate is lower, at 60% F1 and 80% precision, because the feedback filter and prompts need months of real use to reach the full targets. Two more measures are first estimates: no comment is repeated after a push (from Beta), and at least 40% of high-severity findings carry a reproducing test (from 1.1).

### Functional requirements

| ID | Requirement | Surface | Priority |
| --- | --- | --- | --- |
| F1 | Detect MR and PR pages on GitHub.com, GitHub Enterprise, GitLab.com and self-managed GitLab (the user adds hosts) | Extension | P0 |
| F2 | Bring your own key for Anthropic, OpenAI, Google Gemini, OpenRouter, Azure OpenAI and any OpenAI-compatible endpoint, including local Ollama; a test button checks each key | Extension | P0 |
| F3 | Choose a model per role (planner, specialists, verifier), with presets: Best accuracy, Balanced, Low cost, Local only; show a cost estimate before each run | Extension | P0 |
| F4 | One-click review; findings shown beside the diff lines with severity, reasoning, evidence and confidence | Extension | P0 |
| F5 | Post selected findings as GitLab draft notes or a GitHub pending review, using the user's own token | Extension, MCP | P0 |
| F6 | 👍 / 👎 / "not relevant here" plus a reason on every finding; learned on the device; can be exported to the repo | Extension, MCP | P0 |
| F7 | MCP server runs locally with no API key; all reasoning uses the user's own Claude Code or Codex session | MCP | P0 |
| F8 | Claude Code plugin `/RepoSpector` and Codex skill `$RepoSpector`: plan, run specialist subagents in parallel, verify each finding in a fresh subagent, then filter | MCP | P0 |
| F9 | Review-until-clean loop before the agent raises the MR or PR | MCP | P1 |
| F10 | Team rules in `.RepoSpector/rules.md`; also reads CLAUDE.md, AGENTS.md and .cursor rules | Both | P0 |
| F11 | Ticket context from linked GitHub or GitLab issues; Jira with the user's own token | Both | P1 |
| F12 | Runtime check: MCP runs targeted tests locally; the extension can trigger a CI job from a provided template | Both | P2 |
| F13 | Local graph mode: the extension connects to the local RepoSpector service through native messaging when the repo is cloned | Extension | P1 |
| F14 | Open eval harness and golden set; publish scores per model setup | Repo | P1 |
| F15 | Opt-in anonymous metrics: counts only (findings posted, acted on, reactions), never code or file names | Both | P1 |

### What makes it better than the top three

Copying their published techniques gets parity. These eleven features are the bets for going past them. Each one has to show a gain on the golden set before its release, or it is cut.

| ID | Feature | What the user gets | Closest today | Release |
| --- | --- | --- | --- | --- |
| F16 | Proof, not opinion | For a high-severity finding, RepoSpector writes a minimal failing test that reproduces the bug and runs it. Findings are tagged Proven, Verified or Suspected, and the test can be added to the MR | Greptile's TREX runs code and attaches logs | 1.1 |
| F17 | Test-gap check | Mutates the changed lines locally and reports which changes no existing test would catch | Not found in the public docs we read | 1.1 |
| F18 | Agent-MR audit | For agent-written MRs: checks the description's claims against the diff, and flags deleted, weakened or skipped tests and stubbed code | Greptile routes agent PRs to a different model | Beta |
| F19 | Review guide for humans | A risk-ranked reading order, a map of the callers a change affects, and a list of what the AI could not verify | Cubic generates diagrams of changes | 1.1 |
| F20 | Calibrated confidence | Each finding shows its expected precision, measured on the golden set for that model and category | Not found | Alpha |
| F21 | Coverage report | Lists the files and concerns that were not reviewed, and why | Not found | Alpha |
| F22 | Incremental re-review | After a push, reviews only the new commits, marks fixed findings resolved and never repeats a comment | Common in commercial tools; needed for parity | Beta |
| F23 | Institutional memory | Rules mined from reverts and incident-fix MRs, cited in findings ("this pattern was reverted in !123") | Qodo and Greptile learn from PR history | 1.2 |
| F24 | Consensus mode | Best accuracy runs the logic specialist several times with files in different order, then verifies on a second provider | Greptile's cross-model review | 1.1 |
| F25 | Zero-server privacy | No vendor sees code. The Local only preset works offline with Ollama | Greptile and Qodo offer self-hosting | Alpha; Local only preset in 1.0 |
| F26 | Open scores | A public leaderboard of golden-set scores per provider and model setup | Martian ranks products, not model setups | 1.0 |

### Release plan

1. **Foundation (weeks 0–3):** the eval harness, the finding schema and the first 100 golden cases, built before any reviewer code. Score a plain single-pass reviewer as the baseline. Gate: anyone can reproduce the baseline score from the repo.
2. **Alpha (weeks 3–8):** local MCP server and Claude Code plugin on GitHub and GitLab; local code graph; specialists; server-enforced verification; calibrated confidence; coverage report. Two or three pilot teams use it daily from here on. Gate: F1 ≥ 50% on the golden set with a Claude session.
3. **Beta (weeks 8–14):** Chrome extension with bring-your-own-key and the archive-built graph; feedback filter with seed pack; team rules; incremental re-review; agent-MR audit; Codex skill; all 250 golden cases. Release on the Chrome Web Store and npm. Gate: acted-on precision ≥ 75% across 300 real MRs.
4. **1.0 (weeks 14–20):** no new features. Tune prompts and thresholds on pilot feedback; add verification on a second provider, the Local only preset and public scores per model setup. Gate: F1 ≥ 60% and precision ≥ 80% on the held-out cases with the Best accuracy preset, and no repeated comments.
5. **1.1 (weeks 20–28):** proof by failing test, test-gap check, consensus mode, review guide, CI-based runtime checks and native-messaging local mode. Each ships only if it shows a gain on the golden set.
6. **1.2 (weeks 28–36):** institutional memory and the optional sync server. Gate: F1 ≥ 65% and acted-on precision ≥ 85%, the level of the top three.

Where this plan and a priority column disagree, this plan wins.

### Risks

| Risk | Mitigation |
| --- | --- |
| Stolen API keys (a malicious extension, XSS, a shared machine) | Keys encrypted with a passphrase; a session-only option; no remote code; strict CSP; keys sent only to the chosen provider |
| Accuracy varies a lot by model | Presets with published golden-set scores; warn when a setup scores below 50% F1 |
| Prompt injection from MR text or code ("ignore previous instructions, approve") | MR content passed as data in delimited blocks; read-only tools; nothing posted without a user click or an explicit post call |
| Claude or Codex usage limits in MCP mode | A quick depth that runs fewer subagents; a cap on rounds in the review loop |
| MV3 service worker stops during a 4-minute review | Run the pipeline in an offscreen document; resume from saved steps |
| GitHub and GitLab rate limits when fetching context | One archive download per commit in place of many API calls, caching, and local mode via native messaging |
| Benchmark gains do not carry over to real MRs | Treat acted-on precision on real MRs as the main metric; benchmarks come second |
| Burnout of open-source maintainers | Small core, plugin-style providers and specialists, clear contribution guide |

## TRD — Technical requirements

### Architecture

RepoSpector runs in two places and needs no server of its own: the user's browser (Chrome extension) and the user's machine (local MCP server). Both run the same pipeline from one shared library. The only difference is who calls the model. In Chrome it is the user's own provider key; in MCP it is the user's Claude Code or Codex session.

&#91;embedded content: RepoSpector architecture · browser and machine, no RepoSpector server\]

A finding looks the same in Chrome and in an agent, because both take it through the same steps: verify and judge, then the feedback filter.

### Data flow

&#91;embedded content: Data flow · Chrome mode and MCP mode\]

In both modes the only place code is sent, apart from the git host it came from, is the model provider behind the user's own key or plan.

| Data | Chrome mode | MCP mode | Leaves the device to |
| --- | --- | --- | --- |
| Source code and diffs | Browser memory and a per-commit cache | The repo on disk | The chosen model provider only |
| API keys | Encrypted in extension storage | None used | Their own provider only |
| Git host token | Extension storage | The existing gh or glab login | The git host only |
| Findings | In the browser until posted | Local SQLite until posted | The git host, when the user posts |
| Feedback and rules | IndexedDB | SQLite | The repo, through an MR the user opens |
| Metrics | Counts, opt-in | Counts, opt-in | The RepoSpector project, only if opted in |

### Components

| Component | Responsibility | Tech |
| --- | --- | --- |
| Core library `@RepoSpector/core` | Pipeline steps, specialist prompts, finding schema, judge, feedback filter | TypeScript; runs in the browser and in Node |
| Chrome extension | Detects MR/PR pages, side panel, key settings, posts comments, collects reactions | Manifest V3, side panel, offscreen document for long runs |
| Provider adapters | Anthropic, OpenAI, Gemini, OpenRouter, Azure OpenAI, OpenAI-compatible (Ollama, vLLM, LiteLLM) | Direct fetch from the extension to the provider |
| Git host adapters | GitHub REST/GraphQL; GitLab REST v4 for SaaS and self-managed | User's OAuth token or personal access token |
| Remote context builder | Changed files, their imports and callers, within a fetch budget | web-tree-sitter (WASM) + host code-search APIs |
| Local service + MCP server | Code graph of the whole repo built from disk; MCP tools; native-messaging host for the extension | Node, MCP TypeScript SDK, tree-sitter, SQLite |
| Agent skills | Claude Code plugin and Codex skill that run the pipeline with subagents in the user's session | SKILL.md files + agent definitions |
| Feedback filter | Embeds comments on the device and checks them against rejected ones | transformers.js with a small sentence-embedding model; IndexedDB or SQLite |
| Eval harness | Replays golden cases and scores each model setup | Node CLI + GitHub Actions |
| Optional sync server | Shares team feedback and rules between members; self-hostable; off by default | Small Node service + Postgres |

### Review pipeline

Each stage maps to a technique the top three tools have published. A finding reaches the developer only if it survives stages 6 to 9. Stages marked "model" run on the user's key in Chrome and on the user's session in MCP.

1. **Intake.** Fetch the diff, MR description, commits, linked issue and existing comments. Skip drafts, lockfile-only and generated-only changes. On a re-review, take only the commits since the last run.
2. **Risk tier.** Score the change from its size, the paths it touches (auth, payments, migrations) and how many callers it affects. A trivial change gets one combined pass. A standard change gets the full pipeline. A high-risk change also gets consensus runs and proof.
3. **Context build.** For each changed function, collect its callers, callees, imports and similar sibling functions, as Greptile does. MCP reads them from the local graph. Chrome downloads the repo archive at the head commit, builds the graph in a worker and caches it per commit; it uses the local service when the repo is cloned. Add team rules, CLAUDE.md, AGENTS.md and the issue's acceptance criteria. This shared context is sent as a cached prompt prefix, so the specialists do not each pay for it.
4. **Plan (model).** A planner picks the specialists, following Cubic's planner pattern. It splits a large MR into change clusters that each fit the context window, and lists anything it will not cover.
5. **Specialist review (model, in parallel).** Each agent has a narrow job, a short prompt and two tools: code search and graph lookup. Cubic found that fewer tools raised precision. In consensus mode the logic specialist runs three times with the files in different order, and all results go to verification.
   - Logic and correctness
   - Security
   - Concurrency and data integrity
   - Requirements versus the issue
   - Team rules and conventions
   - Duplication and reuse
   - Tests and agent claims: deleted or weakened tests, stubbed code, description claims the diff does not support
6. **Reason-first output.** Every finding is structured as reasoning, then the claim, then evidence (file and line ranges), then confidence, and gets a fingerprint. The core drops any finding whose evidence lines do not exist.
7. **Verify and judge (model).** A verifier with a fresh context re-reads the cited code and tries to disprove the finding. It must cite code whether it keeps or drops the finding. Where possible it runs on a different provider from the specialists. A judge merges duplicates and drops findings whose calibrated confidence falls below the threshold for that model and category.
8. **Proof (optional, high severity).** Write a minimal failing test for the finding and run it. MCP runs it locally on the user's own branch, or in a container for anyone else's MR. Chrome runs it through the CI template. The finding is tagged Proven, Verified or Suspected. The same step runs the mutation probe for test gaps.
9. **Feedback filter (on the device).** Embed each surviving comment with the local model. Block it if it closely matches 3 or more comments the team rejected, or a nit type in the seed pack the team has not accepted. This extends Greptile's published method.
10. **Show.** Rank by severity, fold nits into one line, and add the review guide and coverage report. Skip anything already raised by a person, another bot or an earlier run. Findings stay private until the user posts them.
11. **Learn.** Record reactions, replies and whether the cited lines changed before merge. These feed the filter, the candidate rules and new golden cases.

### Accuracy levers

| Lever | Borrowed from | Main effect |
| --- | --- | --- |
| Code graph context beyond the diff | Greptile | Recall on cross-file and caller-impact bugs |
| Planner + narrow specialists | Cubic, Qodo | Precision and depth per category |
| Fewer tools per agent | Cubic | Precision |
| Reasoning logged before each finding | Cubic | Debuggability; drops unsupported claims |
| Verifier + judge with confidence threshold | Qodo | Precision; removes duplicates |
| Per-team embedding filter on rejected comments | Greptile | Acted-on precision |
| Learning from past MR review history | Qodo, Greptile | Fit to team standards |
| Runtime evidence for risky changes | Greptile TREX | Recall on runtime-only bugs; developer trust |
| Different model reviews agent-written code | Greptile | Catches blind spots the authoring model shares |
| Eval gate on every prompt or model change | Cubic (offline testing) | Prevents silent regressions |

Levers added in the architecture review. None of the three vendors describes these in what we read, so each gain is a bet to be measured on the golden set.

| Lever | Expected effect |
| --- | --- |
| Confidence calibrated per model and category | Precision stays stable across bring-your-own-key models |
| Consensus runs of the logic specialist | Recall on subtle logic bugs |
| Proof by failing test | Precision on high-severity findings; developer trust |
| Mutation probe on changed lines | Finds changes that no test covers |
| Graph built from the repo archive in the browser | Chrome-mode recall close to MCP mode |
| Verify step enforced by the MCP server | Precision cannot be skipped by an agent |
| Risk tiers and cached context | Lower cost, so depth goes where the risk is |

### Data model

| Entity | Where it lives | Key fields |
| --- | --- | --- |
| Settings and keys | Extension, chrome.storage.local, encrypted (never chrome.storage.sync) | provider, encrypted key, model per role, git hosts |
| Rules | Repo: `.RepoSpector/rules.md` | scope (path glob), text, source (manual, mined, CLAUDE.md) |
| Feedback | IndexedDB (Chrome) or SQLite (MCP); repo `.RepoSpector/feedback.jsonl` when shared | comment text, reaction, reason, repo, date |
| Code graph | SQLite in the local service; in memory for one review in Chrome | nodes (file, function, class, variable), edges (calls, imports, uses, contains) |
| ReviewRun | Local | MR ref, head SHA, model setup, cost, latency |
| Finding | Local; posted copies live on the MR | file, lines, severity, reasoning, claim, evidence, confidence, verifier verdict, status |
| GoldenCase | Public eval repo | repo, base and head SHAs, expected issues, label source, verified by |

Every finding has a fingerprint: a hash of its file, enclosing symbol, category and normalized claim. The fingerprint keeps a finding's identity across runs, so a re-review marks it resolved and does not repeat it. Feedback stores comment text with the name of the embedding model, so a model change triggers a re-embed. Calibration tables (model, category, confidence to expected precision) ship with each release.

### MCP tools

| Tool | Input | Output |
| --- | --- | --- |
| plan\_review | branch vs base, or MR/PR URL; depth (quick, standard, deep) | run id, risk tier, changed symbols, specialists to run, one context pack per specialist, commits since the last run |
| get\_context | symbol or path | callers, callees, imports and similar code from the local graph |
| get\_agent\_prompt | specialist name | prompt and output schema for that specialist (also exposed as MCP prompts) |
| submit\_findings | run id, specialist, findings | accepted findings; rejects any whose evidence lines do not exist |
| verify\_batch | run id | findings with their cited code, packed for a fresh verifier subagent |
| prove\_finding | finding id | a failing test, its run result, and the tag Proven, Verified or Suspected |
| finalize | run id, verifier verdicts | judged, de-duplicated and filtered findings; refuses if any finding lacks a verdict |
| review\_guide | run id | reading order, affected callers, and what was not reviewed |
| get\_run\_state | run id | current stage and what is still pending |
| post\_review | run id, finding ids | comments posted as draft notes or a pending review, using the existing gh or glab login |
| record\_feedback | finding id, reaction, reason | stored locally; exported to the repo on request |

The MCP server never calls a model, so it needs no API key. The Claude Code plugin (`/RepoSpector`) and the Codex skill (`$RepoSpector`) drive these tools on the user's own plan: one subagent per specialist, then a fresh subagent as verifier, then finalize. The server, not the skill, enforces that order. It tracks each run's stage and rejects a call made out of turn. Where a client cannot run parallel subagents, the skill runs the specialists one after another or as separate `codex exec` runs. Where a client supports MCP sampling, the server can request the model calls itself. With both tools installed, the verifier can run in the other one, for example Codex verifying code Claude wrote.

### Chrome extension

- Manifest V3 with a side panel. Host permissions are requested at runtime, only for the git hosts the user adds and the providers they enable.
- Bring your own key: keys are encrypted with WebCrypto AES-GCM and unlocked with a passphrase once per browser session. A session-only mode keeps them in memory alone. Keys live only in the extension's own pages, never in content scripts, and are sent only to their provider.
- The pipeline runs in an offscreen document, so MV3 service-worker shutdowns do not kill a 4-minute review. Completed steps are saved so a run can resume.
- MR data comes through the host's API with the user's token: GitHub OAuth device flow or a personal access token; GitLab OAuth (PKCE) or a personal access token for self-managed hosts. The content script only places markers beside diff lines.
- Context: download the repo archive at the head commit, parse it with tree-sitter WASM in a worker, and cache the graph per commit in browser storage. Later commits update only the changed files. Repos over the size limit fall back to changed files plus their imports, and the coverage report says so. Local mode asks the local service through native messaging.
- Comments are posted as GitLab draft notes or a GitHub pending review, so the human chooses what becomes public. On older self-managed GitLab versions without draft notes, they are posted as normal comments after a confirmation.
- No RepoSpector server sees code or keys, and MV3 forbids loading remote code.

### Evaluation harness

- **Golden set:** 250 cases from 50 public repos (40 on GitHub, 10 on GitLab), listed in the Golden set tab. Public repos mean anyone can reproduce the scores. Martian's offline set is used as an external check.
- **Contamination:** models may have seen public fixes in training. A rolling set of 50 fresh cases is mined each quarter from MRs merged after the newest model's cut-off, and reported separately.
- **Calibration:** the tuning split produces the confidence-to-precision tables for each model and category. The held-out split is never used for tuning or calibration.
- **Runs:** on every change to prompts, the pipeline or the presets, in CI. Each run reports precision, recall, F1, cost and latency per specialist and per model setup.
- **Gate:** block a release if F1 drops more than 1 point or precision drops more than 2 points on any preset. A new feature ships only if it raises F1 or cuts cost without lowering F1.
- **Published scores:** a public table of golden-set F1 for each provider and model setup.
- **Online:** acted-on precision from pilot teams and opt-in metrics, reviewed weekly.

Repo list and labeling method: Golden set

### Security and privacy

- No central server in the default setup. Code goes from the git host to the user's browser or machine, then only to the provider the user chose.
- Keys are encrypted at rest, never synced, never logged, never exposed to page scripts and never sent anywhere except their provider.
- Untrusted code: tests and proofs run locally only on the user's own branch. For anyone else's MR they run in a container with no network and no secrets, or in the project's CI.
- Prompt injection: MR text and code are passed as data inside delimited blocks, and agents have read-only tools. Instructions found in MR content are flagged as a finding. The verifier cannot drop a finding without citing code. Nothing is posted without a user click or an explicit `post_review` call.
- Secrets found in diffs are redacted before any model call.
- Opt-in metrics carry counts only, with no code, file names or repo names.
- Supply chain: signed releases, npm provenance, reproducible extension builds, and a minimal permission set reviewed for each release.

### Non-functional requirements

| Area | Requirement |
| --- | --- |
| Latency | p50 ≤ 4 min, p95 ≤ 10 min for a 500-line MR at the Balanced preset (also depends on the provider); trivial tier ≤ 60 s |
| Local indexing | First index of a 1M-line repo ≤ 10 min; incremental update ≤ 30 s |
| Browser graph | Repo archives up to 300 MB; first build ≤ 90 s for a 1M-line repo; cached per commit |
| Cost | User's model spend p50 ≤ $0.60 per MR at Balanced; estimate shown before each run |
| Re-review | Only new commits are reviewed; no repeated comments |
| Footprint | Embedding model and grammars downloaded once on first use and cached |
| Languages | Go, Java, Python, TypeScript/JavaScript and Ruby at launch |

## User flows

### Flow 1 — Review an MR in Chrome

The developer stays on the MR page throughout. Findings stay private in the panel until someone chooses to post them, and every reaction feeds the team's filter.

&#91;embedded content: Flow 1 · MR review in Chrome, with fix and feedback loops\]

Only "Post selected" makes anything public; fixes trigger a fresh review, and reactions change what the filter lets through next time.

### Flow 2 — A coding agent reviews its own work through MCP

1. The developer finishes a change in Claude Code or Codex and runs `/RepoSpector` (Codex: `$RepoSpector`). No API key is involved.
2. The skill calls `plan_review`. The local server diffs the branch against its base and returns the specialists to run, each with a context pack.
3. The agent starts one subagent per specialist, in parallel, on the user's own session. Each subagent calls `submit_findings`.
4. A fresh subagent that never saw the authoring conversation verifies every finding through `verify_batch`. `finalize` judges, removes duplicates and applies the team's feedback filter.
5. In loop mode, the agent fixes blocking findings and runs the review again, up to three rounds.
6. The agent raises the MR or PR. `post_review` can post the remaining non-blocking findings as draft notes, and a short review summary goes into the description.

### Flow 3 — Install and onboard a team

1. **Chrome:** install from the Chrome Web Store. In settings, add a key for one or more providers and pick a preset: Best accuracy, Balanced, Low cost or Local only. A test call checks each key.
2. Connect GitHub (device flow) and GitLab (OAuth, or a personal access token plus the host URL for self-managed). Chrome asks for permission for each host.
3. Open any MR or PR. The panel shows a Review button with an estimated cost.
4. **MCP:** run `claude mcp add RepoSpector -- npx -y RepoSpector-mcp`, or add the same command to Codex's MCP config, then install the plugin or skill. The first run indexes the local repo.
5. **Optional:** `npx RepoSpector init` adds `.RepoSpector/rules.md`, seeded from CLAUDE.md and AGENTS.md, plus candidate rules mined from recent review comments. The team edits and merges it like any other MR.

### Flow 4 — Feedback and learning

1. A developer reacts 👎 to a finding and optionally says why.
2. The reaction is stored on the device with the comment's text, and the filter embeds it locally. Once 3 similar comments are rejected, comments like them are blocked.
3. A finding whose cited lines change before merge counts as acted on, even without a reaction.
4. A lead clicks Share learnings (or runs `npx RepoSpector learn export`). This opens an MR that adds the team's feedback and candidate rules to `.RepoSpector/`, and teammates get them on their next pull.
5. A recurring miss can be filed as a new case in the open golden set.

### Flow 5 — A human reviewer uses the review guide

1. The reviewer opens the MR. The panel shows the risk tier, a reading order, and the callers the change affects.
2. Proven findings come first, each with its failing test. One click adds the test to the MR as a suggestion.
3. The coverage report lists what the AI did not review or could not verify. The reviewer spends their time there.
4. The reviewer posts the findings they agree with and approves or requests changes.

### Flow 6 — Re-review after a push

1. The author pushes new commits.
2. RepoSpector reviews only those commits. Earlier findings whose code changed are verified again and marked resolved if fixed.
3. Only new findings appear. Nothing already raised is repeated.

## Open questions and assumptions

**Decided (2026-11-17)**

- Open for everyone, free and open source.
- Chrome extension: bring your own key, with several providers and models.
- MCP: uses the user's own Claude Code or Codex session; no key.
- GitLab and GitHub together from launch.
- Golden set: 50 public repos, picked and labeled as described in the Golden set tab.

**Still open**

- [ ] License: Apache-2.0 or MIT?
- [ ] Which embedding model ships for the on-device filter (size versus quality)?
- [ ] Should the optional sync server be in scope for 1.0, or left to the community?
- [ ] Who reviews the labels the labeling pipeline marks as low agreement?
- [ ] "RepoSpector" is a working name; check trademark and Web Store availability.

Assumptions: the leaderboard numbers are the Martian online figures you shared; cost and latency targets are first estimates to be checked in the alpha.

## Sources

- [Martian Code Review Bench explained (CodeAnt)](https://codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests)
- [Comparing code review benchmarks (Qodo)](https://www.qodo.ai/glossary/what-is-ai-code-review-benchmarks/)
- [Greptile: graph-based codebase context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context.md)
- [Greptile: How to make LLMs shut up](https://greptile.com/blog/make-llms-shut-up)
- [Greptile v3: agentic code review](https://greptile.com/blog/greptile-v3-agentic-code-review)
- [Greptile TREX: running code in review](https://www.greptile.com/blog/trex)
- [Greptile changelog (cross-model review)](https://greptile.com/changelog)
- [Cubic: Learnings from building AI agents](https://www.cubic.dev/blog/learnings-from-building-ai-agents)
- [Qodo core features (multi-agent + judge)](https://docs.qodo.ai/qodo-core-features)
- [Qodo 2.0 announcement](https://www.qodo.ai/blog/introducing-qodo-2.0-agentic-code-review/)

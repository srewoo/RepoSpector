# Design — Precision measurement, GitHub Enterprise, convention warm-up, hunk windowing

Date: 2026-08-18
Status: approved, pending implementation plan

## Why these four

They are the four gaps an audit of the repo found that the code itself already
admits to. Each is named in `eval/README.md` or in a source header, and none of
them is a new feature request — they are unfinished work with a documented
motivation.

| # | Gap | Where the repo already says so |
|---|---|---|
| 1 | Precision is unmeasured — 272 findings, 0 adjudicated | `eval/README.md` "Still open" §1 |
| 2 | No GitHub Enterprise support | `src/utils/gitHosts.js` covers GitLab only |
| 3 | ConventionMiner is cold on a first review | `eval/README.md` "Still open" §2 |
| 4 | Misses concentrate in large files | `eval/README.md` "What the misses say" |

Self-hosted **GitLab** is already supported (`gitHosts.js`, runtime host
permissions, dynamic content-script registration). Only GitHub Enterprise is
missing. This spec does not re-do the GitLab work.

---

## Item 1 — Precision, measured and labeled

### The problem

`eval/results/adjudicate-all.csv` holds 152 findings and
`adjudicate-posted.csv` holds 61; every `verdict` cell is empty. Across
`eval/corpus/public-prs.json` (152 predictions) and `eval/corpus/injected.json`
(120), that is **272 findings with 0 adjudications**. Recall is measured;
precision is not. For a review bot the false-positive rate is the adoption
ceiling, so the more consequential of the two numbers is the missing one.

### The constraint we are deliberately working against

`eval/adjudicate.js` opens with the repo's own finding: the pipeline's LLM
verifier "was measured passing 42 of 42 findings that human adjudication then
rejected", and an LLM adjudicator would therefore "produce a precision figure
with no demonstrated relationship to correctness — worse than no figure, because
it would get quoted."

The decision taken is to adjudicate with an LLM anyway, for reach, and to
neutralise the "it would get quoted" failure mode structurally rather than by
convention. That is what the labeling and baseline-refusal below are for.

### Design

**Schema.** `adjudications[]` entries gain an optional `source` field:

```jsonc
{ "file": "src/a.py", "line": 10, "verdict": "true_positive", "source": "llm" }
```

Absent `source` means `human`. This keeps every already-committed corpus and the
documented format in `eval/README.md` valid.

**Scoring** (`eval/lib/scoring.js`). `scorePrecision` partitions verdicts by
source and returns two independent rates, each with its own Wilson interval:

- `precisionHuman` / `precisionHumanLow` — over `source: 'human'` verdicts
- `precisionLlm` / `precisionLlmLow` — over `source: 'llm'` verdicts

The two are never pooled into a single `precision`. Pooling is precisely the
mechanism by which an unfalsifiable number acquires the authority of a measured
one. Unadjudicated findings continue to be counted separately and excluded from
both rates, as today.

**Report formatting** (`formatReport`). Any line derived from LLM verdicts is
suffixed `LLM-adjudicated — not authoritative`. There is no verbosity flag that
removes it.

**Baseline protection** (`eval/score.js`). `--write-baseline` exits non-zero when
any contributing verdict has `source: 'llm'`, unless `--allow-llm-baseline` is
passed. The regression gate stays anchored to human judgment by default, so an
LLM-derived figure cannot silently become the bar the project defends.

**Worksheet with real code** (`eval/adjudicate.js`). New `--export-context`
emits, for each prediction, the hunk surrounding its line, sliced from
`prData.files[].patch`. All 129 files across the 22-case corpus carry a patch, so
this is fully offline — no GitHub API calls, no token spend.

**The adjudication pass.** Every one of the 272 findings is judged against its
real hunk, written back with `source: 'llm'`, and reported under the label above.
Judgment is against the diff, not against whether the finding reads plausibly —
the distinction the retired LLM verifier failed on.

### Files touched

- `eval/lib/scoring.js` — partitioned precision, two intervals
- `eval/score.js` — baseline refusal, report labeling
- `eval/adjudicate.js` — `--export-context`, `source` round-trip
- `eval/README.md` — record the numbers and the label
- `eval/corpus/*.json` — verdicts written (gitignored, not committed)

---

## Item 2 — GitHub Enterprise

### The problem

`detectPlatform` matches `github.com`, `www.github.com` and `api.github.com`
exactly. Every other GitHub host returns `null` (unsupported) or, through
`detectPlatformOrGitHub`, falls back to GitHub and then issues its API calls
against `api.github.com` — the wrong server. Roughly a dozen call sites also
still hardcode the host, so even a correct platform decision would not be enough.

### Design

**`src/utils/gitHosts.js`** gains the GitHub mirror of the existing GitLab
machinery:

- `githubApiBase(url)` — `github.com` → `https://api.github.com`; any other host
  → `https://<host>/api/v3` (GHE Server's REST root), preserving scheme and a
  non-default port exactly as `gitlabApiBase` does
- `githubRawBase(url)` — `github.com` → `https://raw.githubusercontent.com`;
  GHE → `https://<host>` with the `/<owner>/<repo>/raw/<ref>/<path>` shape
- `setGitHubHosts` / `rememberGitHubHost` / `isKnownGitHubHost` /
  `getGitHubHosts` / `resetGitHubHosts`, seeded with `github.com` and always
  retaining it

**Detection is configuration-only for GHE, and this asymmetry is intentional.**
GitLab earns structural detection because `/-/` is a route marker unique to
GitLab, so an unregistered internal host still works on first visit. GitHub's
`/pull/<n>` is *not* unique — Codeberg, Gitea and other forges in the manifest
use the same or near-same shape — so inferring GitHub from path structure would
misroute those hosts to the GitHub API. GHE therefore requires a configured
host. The header comment in `gitHosts.js` will state this reasoning so it is not
"fixed" later by someone who reads the asymmetry as an oversight.

**Call sites routed through the abstraction:**

| File | Lines |
|---|---|
| `src/utils/constants.js` | 61, 62, 503, 515 |
| `src/services/GitHubService.js` | 16 |
| `src/services/PullRequestService.js` | 17, 18, 829 |
| `src/services/LinkedIssueService.js` | 206, 207 |
| `src/background/handlers/prReviewHandlers.js` | 2393 |
| `src/utils/contextAnalyzer.js` | 393, 534, 820, 1108, 1142, 1189, 1215, 1374, 1388, 1407, 1436 |
| `src/services/StandardsSyncService.js` | 76 |

Without the `contextAnalyzer` half, GHE would review a PR but silently fail
every full-file, repo-tree and dependency fetch — a partial support story that
looks like a bug to the user.

**Settings.** A "GitHub Enterprise hosts" free-text field beside the existing
GitLab one, parsed by the existing `parseHostList`. `ensureHostAccess` extends to
request permissions and register the content script for both lists; its current
`h !== 'gitlab.com'` filter generalises to "drop the public hosts of either
forge". The registered content-script id stays a single
`repospector-selfhosted` covering all granted origins.

**Manifest.** No change. `optional_host_permissions` already spans
`https://*/*`, and runtime grant is the existing mechanism.

---

## Item 3 — ConventionMiner warm-up

### The problem

`src/background/handlers/prReviewHandlers.js:1399-1416`: on a cache miss the
miner is started in the background and the current review proceeds with generic
standards. The comment states the tradeoff honestly — blocking "would add a full
LLM round-trip to a first review for a benefit that arrives later anyway."

The cost is that the component the eval identifies as the highest-leverage
remaining recall lever contributes nothing to any first review, and nothing to
any measured run, since each eval case is a first review of its repo. The
component cannot be evaluated at all in its current wiring.

### Design

**In-flight registry.** A module-level `Map<repoId, Promise>` in
`ConventionMiner`, so a prewarm triggered by indexing and a review starting
moments later collapse to one LLM call instead of two. Entries are deleted on
settle.

**`prewarm(repoId, notesFetcher, opts)`** — returns the in-flight promise if one
exists, otherwise fetches review comments and starts mining. Idempotent and safe
to call from several places.

**Triggers:** repo index completion (`indexingHandlers`) and PR-page detection.
Both are moments the user is already waiting on something else, so the call is
free in practice.

**Review path becomes:**

1. cache hit → render the block, as today
2. mining in flight → `await Promise.race([inflight, deadline])`
3. neither → start it fire-and-forget, as today

`CONVENTION_WARM_DEADLINE_MS = 15000`, overridable via settings. A review is
never blocked indefinitely, and the fallback to generic standards is unchanged —
so the worst case is exactly today's behaviour plus at most 15s on a cold repo.

### Files touched

- `src/services/ConventionMiner.js` — registry, `prewarm`, deadline constant
- `src/background/handlers/indexingHandlers.js` — trigger on index completion
- `src/background/handlers/prReviewHandlers.js` — the three-branch await
- `src/utils/constants.js` — deadline default

---

## Item 4 — Hunk windowing for large files

### The problem

`eval/README.md` reports that both remaining `loose-equality` misses and three of
nine `unchecked-error` misses sit in large files (react `store.js`, prometheus
`head_wal.go`, kubernetes `scheduling_queue.go`), while the same defect classes
are caught 100% of the time in small files, and reads this as attention dilution
rather than a rule gap.

The mechanism is confirmed in code. `FileGroupingStrategy.group()` gives a
high-risk or large file a **solo** review unit, but nothing anywhere splits a
single file's diff. A 900-line diff enters one prompt whole.

`prData.files[]` entries carry `filename`, `status`, `additions`, `deletions` and
`patch` — **no** pre-parsed `hunks` array. So the windower splits the `patch`
text itself on `@@ -a,b +c,d @@` headers, reusing the header shape already used
at `src/utils/diffParser.js:238`. It does not instantiate `DiffParser`: that
class consumes a whole multi-file diff, which is the wrong input granularity
here, and pulling a 1000-line parser into the grouping path to find hunk
boundaries in one patch would be the more complex option, not the simpler one.

`src/utils/reviewContextBudget.js` already anticipates this exact risk in its
header and documents the A/B path, which this item follows rather than invents.

### Design

**New `src/services/HunkWindower.js`** — one purpose, no dependencies beyond the
parsed diff:

```js
windowSoloFile(file, {
  minLocToSplit: 250,   // below this, one unit, unchanged behaviour
  maxLocPerWindow: 200, // target size of a window
  overlapLines: 20,     // trailing context carried into the next window
})
```

Returns one sub-unit per window, each carrying `windowIndex`, `windowTotal`, its
subset of hunks, and a prompt note that sibling windows of the same file exist —
so the model does not report "the rest of the file is missing" as a finding.
Windows never split an individual hunk; a single hunk larger than
`maxLocPerWindow` becomes its own window.

**Integration.** `FileGroupingStrategy.group()` expands an oversize solo unit
into windowed units. Findings merge back through the existing `findingDedup` and
`commentDedupe` paths, which already deduplicate per file and line — the overlap
region is the only place duplicates can arise and those paths already handle it.

**Default off.** The default lives in `src/utils/constants.js` as
`HUNK_WINDOWING: false`, overridable per-run by `REPOSPECTOR_HUNK_WINDOWING=1`
for the eval, mirroring the existing `REPOSPECTOR_CONTEXT_PROFILE` convention. Windowing multiplies LLM calls on
exactly the largest files, so it does not ship on until measurement justifies it.

**Targeted measurement.** A corpus subset of the known-miss large-file cases,
run with the flag on and off, reporting the detection delta on those cases. This
is a deliberately cheap experiment — a full A/B over both benchmarks was scoped
out. Its result decides the default, and a null result means the flag stays off
and the dilution hypothesis is recorded as unsupported.

### Files touched

- `src/services/HunkWindower.js` — new
- `src/services/FileGroupingStrategy.js` — expand oversize solo units
- `src/utils/constants.js` — the `HUNK_WINDOWING` flag default
- `eval/` — subset corpus + recorded before/after

---

## Testing

TDD throughout; a failing test precedes each change.

| Area | Cases |
|---|---|
| `scoring` | human-only, llm-only, mixed, empty; rates never pooled; unadjudicated excluded |
| `score.js` | `--write-baseline` refuses llm verdicts; `--allow-llm-baseline` permits |
| `adjudicate.js` | `--export-context` hunk slicing; `source` survives export→import |
| `gitHosts` | GHE api/v3 base, port and scheme preserved, subdomain matching, `github.com` unchanged, other forges still `null` |
| `ensureHostAccess` | both host lists, public hosts filtered, rejected prompt is non-fatal |
| `ConventionMiner` | concurrent prewarm+review yields one call; deadline falls back to generic; cache hit skips mining |
| `HunkWindower` | below threshold → one unit; boundaries; overlap; single oversize hunk; window metadata |

The existing suite is 100 files / 1509 tests and must stay green.
`eval/corpus/**` and `eval/results/**` remain gitignored — they hold real diffs
and review comments.

## Order of work

1 → 2 → 3 → 4. Item 1 is offline analysis and builds the measurement path item 4
depends on. Items 2 and 3 are independent of both.

## Out of scope

- Human re-adjudication of the 272 findings (the number stays labeled until then)
- A full A/B of hunk windowing over both benchmarks
- Structural (configuration-free) GHE detection
- The bundle-size, XOR-fallback and permission-scope findings from the same audit

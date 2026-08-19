# Evaluation harness

Measures whether RepoSpector's review output is any good, and stops it silently
getting worse.

## Why this exists

The pipeline's design decisions cite a 50-MR benchmark — precision 0% (95% CI
[0, 8.4%]) and 1.8% recall against human comments — and the deterministic
evidence gates, the full-file context pass and the posting policy all exist
because of those numbers. But the corpus, the scorer and the results were all
gitignored, so **none of it could be reproduced, and no change could be shown to
have helped.** A reviewer whose accuracy is unmeasurable is a reviewer whose
accuracy claims are unfalsifiable.

The harness is now committed. The data still is not — see *Privacy* below.

## Two benchmarks, two questions

They are routinely conflated, and conflating them is how tools end up quoting a
flattering number for a capability nobody asked about.

| | **Human-comment recall** | **Injected-defect recall** |
|---|---|---|
| Question | "Does it review like our team?" | "Can it find a bug at all?" |
| Ground truth | what reviewers actually said | defects we planted, location known |
| Precision | needs human adjudication | mechanically measurable |
| Comparable to Qodo's PR Benchmark | no | yes |
| Scores | brutally | generously |

```bash
# Human-comment benchmark
node eval/fetch-github.js --limit 8
node eval/run.js
node eval/score.js --corpus eval/corpus/public-prs.json --misses

# Injected-defect benchmark (Qodo-comparable methodology)
node eval/inject.js --list                    # see the defect catalogue
node eval/inject.js                           # plant defects in the fetched corpus
node eval/run.js   --corpus eval/corpus/injected.json
node eval/score.js --corpus eval/corpus/injected.json --misses
```

Injection only ever rewrites **added** lines in **non-test** source files. A
defect on a context line is pre-existing code the reviewer is told to ignore, so
a miss would be correct behaviour scored as a failure; a defect in a test file
is a bug in the test, and staying quiet about it is defensible. Every injection
records `before`/`after` so any one of them can be audited.

Planted defects are written into `humanComments`, so the same scorer reports
detection rate as recall — one matcher, one interval calculation, one definition
of "same location" across both benchmarks.

## Metrics

| Metric | Question | Ground truth |
|---|---|---|
| **Precision** | Of the findings we reported, how many were real? | A human's `true_positive` / `false_positive` verdict per finding |
| **Recall** | Of the comments a human left, how many did we also raise? | The MR's actual review comments |

Both are proportions from small samples, so every rate is reported with a
**Wilson 95% interval**, and the gate compares **lower bounds**. `1/1` is not
"100% precision", and a lucky three-MR run must not ratchet the bar somewhere
the next run cannot reach.

Findings are pooled across MRs, not averaged per MR — averaging gives a
one-finding MR the same weight as a forty-finding one.

A prediction matches a reference when the file matches and the lines are within
`--tolerance` (default 5). A human comment with no line matches anywhere in that
file, because reviewers legitimately comment on a file as a whole.

## Corpus format

```jsonc
{
  "cases": [
    {
      "id": "acme-svc-1421",                       // unique; namespaces file paths
      "url": "https://gitlab.acme.internal/...",   // optional, for traceability
      "predictions":   [ { "file": "src/a.py", "line": 10, "title": "..." } ],
      "adjudications": [ { "file": "src/a.py", "line": 10, "verdict": "true_positive" } ],
      "humanComments": [ { "file": "src/a.py", "line": 12, "body": "...",
                           "substantive": true } ]
    }
  ]
}
```

- `predictions` — dump `verifiedFindings` from a review run.
- `adjudications` — one entry per prediction you judged. Unjudged predictions
  are counted as *unadjudicated*, never as wrong: punishing the tool for
  findings nobody got round to reading would make the number meaningless.
- `humanComments` — set `"substantive": false` on "LGTM"-class comments so they
  do not depress recall.

Validation is strict and fails loudly. A silently-skipped malformed case
inflates exactly the rates it should lower.

## Running it

```bash
# Score a run
node eval/score.js --corpus eval/corpus/mr-50.json

# Machine-readable
node eval/score.js --corpus eval/corpus/mr-50.json --json > eval/results/run.json

# Fail (exit 1) if this run is worse than the recorded baseline
node eval/score.js --corpus eval/corpus/mr-50.json --gate

# Accept the current numbers as the new bar
node eval/score.js --corpus eval/corpus/mr-50.json --write-baseline
```

`npm run eval` scores the synthetic fixture; `npm run eval:gate` gates on it.

## The baseline, and what CI actually checks

`eval/baseline.json` records the thresholds the gate enforces. Its committed
values come from `eval/fixtures/synthetic.json`, a hand-written non-proprietary
set.

**This is important and easy to misread:** the synthetic fixture exercises the
*scorer*, not the reviewer. Its predictions are hand-written. CI running green
means the measurement code still matches, tolerates, pools and reports
correctly — it says **nothing** about how good RepoSpector's reviews are.

Real accuracy numbers require the private corpus:

```bash
node eval/score.js --corpus eval/corpus/mr-50.json --write-baseline   # once
node eval/score.js --corpus eval/corpus/mr-50.json --gate             # thereafter
```

Run that before merging any change to prompts, finder lenses, evidence gates or
posting policy. Those are the components whose regressions unit tests cannot
see.

### Current status — measured

Two benchmarks, 22 real merged PRs, `openai:gpt-5`, shipped defaults.

**Human-comment recall** — "does it review like our team?"

| Corpus | Findings | Recall | 95% CI |
|---|---|---|---|
| 5 PRs, unnumbered diff, no multi-finder | 6 | **0.0%** (0/26) | [0.0 – 12.9%] |
| 5 PRs, numbered diff + multi-finder | 34 | **30.8%** (8/26) | [16.5 – 50.0%] |
| **22 PRs, numbered diff + multi-finder** | **126** | **23.0%** (31/135) | **[16.7 – 30.7%]** |

The 22-PR figure is the one to quote. 30.8% on five PRs sat inside this interval,
so the small corpus was not wrong — it was just optimistically sampled and far
too wide to distinguish 20% from 50%. 236k in / 238k out tokens.

**Injected-defect detection** — "can it find a bug at all?", Qodo-comparable
methodology.

```
13 PRs, 20 planted defects
Detection: 75.0%   95% CI [53.1% – 88.8%]   15/20

  inverted-condition-js   3/3   100.0%
  inverted-condition      1/1   100.0%
  nullish-to-or           1/1   100.0%
  unchecked-error         6/9    66.7%
  loose-equality          4/6    66.7%
```

284k in / 274k out tokens.

#### Reading these two numbers together

75% detection and 23% recall are not in tension — they measure different things,
and the gap between them IS the finding:

- **The reviewer is competent at localized, mechanical defects.** Inverted
  guards, dropped `??`, weakened equality: it finds them, on the right line.
- **It does not review like a human reviewer.** 104 of 135 human threads are
  still missed, and they are dominated by comments no rule set produces —
  *"factor this out, `tokenize_bytes` already has cognitive complexity 551"*,
  *"add to the docstring"*, *"I thought we agreed on ordered=True"*. These need
  repo history, the last design discussion, and project conventions.

**Do not compare 75% to Qodo's reported 56.7% recall / 60.1% F1.** Their
benchmark is 100 PRs and 580 *complex* injected defects; this one is 13 PRs and
20 single-line mechanical mutations. The methodology matches; the difficulty does
not. A fair comparison needs a harder defect catalogue — multi-line and
cross-function defects are the obvious next addition.

#### What the misses say

Both remaining `loose-equality` misses and three of nine `unchecked-error` misses
are in large files (react `store.js`, prometheus `head_wal.go`, kubernetes
`scheduling_queue.go`). The pattern is consistent with attention dilution on big
files rather than a rule gap — the same defect class is caught 100% of the time
in small files. Worth testing directly before adding rules.

**Hunk windowing (`HUNK_WINDOWING` in `src/utils/constants.js`) is not that test,
and any A/B run through `eval/run.js` would not measure what it looks like it
measures.** Two independent problems, not one:

1. Windowing shrinks the diff shown per window but not the surrounding context.
   `_getStaticFindingsForUnit` and `fileContext` in `MultiPassReviewEngine.js`
   are keyed on FILENAME, not window, so every window's prompt still carries
   ALL of that file's static findings (including ones on lines that window
   cannot see) and, when full-file content is attached, the entire file is
   re-sent per window. The attention-dilution hypothesis above is about too
   much context in one prompt; windowing multiplies prompt count without
   removing the thing hypothesized to dilute attention. Per-window keying of
   static findings and file context is a precondition for this flag meaning
   anything, and it does not exist yet.
2. `eval/run.js`'s measurement arm passes no `fileContext`, `ragContext`, or
   `conventionBlock` at all (see its `settings`/review-call construction) — it
   never runs the composition production actually uses. So even with (1) fixed,
   a windowing A/B run through this harness would be measuring a reviewer
   configuration that does not exist in the shipped product, and any number it
   produced would not transfer.

`HUNK_WINDOWING` stays `false` until both are addressed. See the flag's own
comment in `constants.js` for the full reasoning.

**`REPOSPECTOR_CONTEXT_PROFILE` (`reviewContextBudget.js`) is wired but, for
the same underlying reason as (2) above, inert.** `eval/run.js` now reads the
env var, resolves it through `resolveBudget()`, and threads the result into
`context.contextBudget` on the real `MultiPassReviewEngine.execute()` call —
`legacy`/`default` are labelled in the run's log line and recorded per-case in
`runStats.contextProfile`, and `--resume` will not mix the two. That is a real
switch. It is not a real experiment: every key `LEGACY_BUDGET` and
`DEFAULT_BUDGET` differ on (RAG chunk count/size, graph context size, full-file
fetch count, caller-source inlining) governs `ragContext`, `graphContext`, or
`fileContext` — none of which this harness builds. `legacy` and `default`
therefore produce byte-identical prompts here; a diff between the two runs is
guaranteed to be null, not a finding. Building context parity with
`prReviewHandlers` (real RAG retrieval, real graph context, real file fetch)
is what would make this comparison mean something, and that's out of scope
for this harness as it stands — it needs live indexing/network access.

And per the misses above: if attention dilution on large files is the real
question, `maxFullFiles` (the one budget key that moved least, 10 → 16) is not
the lever to pull. The knob that decides whether full file bodies enter a
prompt AT ALL is `options.fetchFullFiles` in `prReviewHandlers.js`, a boolean.
Full-file-context on-versus-off is the experiment that would actually test
dilution; legacy-vs-default context profile never was.

#### LLM-adjudicated precision (not authoritative)

272 findings — 152 in `public-prs`, 120 in `injected` — were judged against the
diff hunk containing their reported line, using the `--export-context`
worksheet, by four independent LLM adjudicators working disjoint slices
(76/76/63/57). Each was instructed with this repo's own cautionary datum (the
retired LLM verifier passed 42 of 42 findings human adjudication then
rejected), seven explicit false-positive criteria, and no expected precision.
For `injected`, the planted-defect answer key was withheld (verified: 0 of 20
planted-defect comment bodies appear in the adjudicators' worksheets), so
non-planted findings were judged on merit rather than against the key.

| Corpus | Cases | Precision (LLM) | 95% CI | Ratio |
|---|---|---|---|---|
| `public-prs` (real merged PRs) | 22 | **6.9%** | [3.8% – 12.2%] | 10/145 |
| `injected` (planted defects) | 13 | **23.3%** | [16.5% – 31.7%] | 27/116 |

`Precision (human)` remains `n/a` (0/0) on both corpora. That is correct and
intended — no human has adjudicated anything, and the authoritative rate stays
unmeasured until one does. **Do not read 6.9% or 23.3% next to Qodo's recall
figures above** — those are two different questions (this repo's findings
judged against this repo's diffs) and nothing here is comparable to Qodo's
benchmark or methodology.

This is a bad result reported honestly, not an improvement: a review tool that
is right about one finding in fourteen (`public-prs`) is not something to
ship on unadjudicated. The achievement is that the false-positive rate is now
known at all, not that it is good.

**Three caveats that belong beside these numbers, not in a footnote:**

1. **These are the generous reading — the +/-5 line tolerance spreads true
   positives.** Stored adjudications are 7 `true_positive` of 142 for
   `public-prs` and 21 of 114 for `injected`, but the scorer reports 10/145 and
   27/116, because a `true_positive` verdict also marks neighbouring
   predictions within 5 lines as true (the documented rule in `scoring.js`).
   The stricter, location-exact rates are **4.9%** (`public-prs`) and **18.4%**
   (`injected`).
2. **13 of 272 findings were left blank as genuinely undecidable — and zero
   were blank for want of a covering hunk.** An exhaustive audit confirmed
   every one of the 272 resolved to a hunk that genuinely contains its
   reported line: the generated worksheets contain zero occurrences of the
   "No hunk in the stored patch covers this line" marker, so nothing was
   skipped for lack of diff context. `eval/adjudicate.js` has a code path for
   that case; it simply went unused for this corpus. The 13 blanks split into:
   - **5 by adjudicator judgment**, each because the claim depends on code
     outside the shown window: `pandas#65098
     pandas/core/reshape/concat.py:172`, `airflow#68833
     .../services/public/event_logs.py:35`, `grafana#129228
     .../legacy_storage/routes.go:299`, and `kubernetes#138075
     staging/src/k8s.io/apiserver/pkg/server/options/etcd.go:285` and `:322`.
   - **8 by controller ruling** — four locations that appear in *both*
     corpora (`kubernetes#138916`, `dynamicresources_test.go:6126` and
     `:6162`, `prequeueing_race_test.go:38` and `:78`), all claiming
     `new("claim-x")` is an invalid builtin call. This is a cross-corpus
     disagreement, not one adjudicator reversing another on the same
     finding: different adjudicators independently judged the `public-prs`
     copy and the `injected` copy of each location and reached opposite
     verdicts. Resolved empirically: go1.25.4 does reject `new("claim-x")`,
     but a package-level `func new[T any](v T) *T` legally shadows the
     builtin and would make the same line compile. The PRs' patches add no
     such helper, but one may pre-exist outside the stored hunk — not
     settleable from the evidence shown.

   This reconciles exactly: `public-prs` 152 rows − 9 blank (5 judgment + 4
   controller) = 143 judged, 142 distinct locations after the one known
   (file, line) collapse; `injected` 120 rows − 4 blank (controller only) =
   116 judged, 114 distinct after its two collapses. 256 locations judged in
   total.
3. **The adjudication schema cannot represent two findings on one line.**
   Adjudications are keyed by (file, line), not by finding. One location
   (`grafana#129228 imported.go:41`) held two distinct findings — a real
   discarded-error bug and a micro-optimisation preference — that received
   opposite verdicts; `true_positive` was stored, per the existing convention
   in `scoring.js` for a split. This overstates precision by at most one
   finding in 272. Three predictions total collapse onto an existing (file,
   line): one in `public-prs`, two in `injected`.

**What the false positives were, by frequency** — the four adjudicators
converged independently on the same failure modes:

1. Speculation with no triggering evidence in the diff — "callers may pass
   nil", "if other tests run in parallel", "may not be implemented" — nothing
   in the hunk suggests the condition arises.
2. **Static-rule findings whose premise no hunk contained** — every
   `no-dupe-keys` / `no-unreachable` hit pointed at a hunk with no object
   literal and no dead code; several flagged the very unreachable code the
   diff deleted. This one is a static-analysis line-mapping problem, not an
   LLM problem, and is the most mechanically fixable class of the six.
3. Flagging unchanged context lines — pre-existing code the reviewer is
   explicitly instructed to ignore.
4. Premise contradicted by a line visible in the hunk — e.g. claiming a symbol
   is never imported when the import is in the shown context, or "returns
   non-nil hintKeys" against a visible `return entities, nil`.
5. Factually wrong claims about a language or API — `for range int` "won't
   compile", WebSocket `OPEN` "not on the instance", `bytes.Clone` "needs Go
   1.20", `go.yaml.in/yaml/v2` "invalid".
6. A large secondary bucket of micro-performance and style restatements with
   no functional consequence.

**The gate is untouched.** `--write-baseline` on `public-prs` refuses with
exit 1 ("145 finding(s) are LLM-adjudicated and none are human-adjudicated"),
and `eval/baseline.json` is byte-identical before and after. `npm run
eval:gate` still reports "No regression".

**Recall is unchanged — verified, not assumed.** Re-scoring after this work
reproduces the same recall figures already recorded above (23.0% [16.7% –
30.7%], 31/135 on `public-prs`; 75.0% [53.1% – 88.8%], 15/20 on `injected`;
same per-class detection rates). That match is the evidence that the scoring
changes behind this precision work did not disturb the existing recall
measurements — it was checked, not presumed.

#### Deterministic gates — measured effect (`eval/gate-replay.js`)

The false-positive taxonomy above was a list of things to fix. Four of the six
classes are now gated deterministically, and `node eval/gate-replay.js` replays
every gate over an adjudicated corpus so the effect is measured rather than
asserted. No model, no network: the gates are pure functions of a stored patch,
so any corpus carrying `adjudications` is enough.

| Corpus | Precision before | Precision after | FPs removed | **TPs removed** |
|---|---|---|---|---|
| `public-prs` | 4.9% (7/143) | **5.9%** (7/118) | 25 | **0** |
| `injected` | 19.0% (22/116) | **23.7%** (22/93) | 23 | **0** |

48 adjudicated false positives removed across 272 findings, with **zero**
adjudicated true positives lost. `TPs removed` is the number that decides whether
a gate ships; precision bought by deleting real bugs is not precision.

| Gate | Class it kills | `public-prs` | `injected` |
|---|---|---|---|
| `static-premise-gate` | 2 — rule fired where its construct does not exist | 22 | 21 |
| `speculation-gate` | 1 — hedged hypothetical with no trigger in the diff | 2 | 0 |
| `import-claim-gate` | 4 — "X not imported" with the import visible | 1 | 2 |
| GATE 2 (context lines) | 3 — finding anchored to unchanged code | 0 | 0 |

Three results here are worth more than the headline number:

1. **The static gate had to mean what the rule means.** Checking that
   `no-dupe-keys` had *an object literal* nearby killed 7 findings; requiring an
   actual **repeated key** killed all 22, because real diffs are full of object
   literals. Same for `no-unreachable`: the terminator has to be **above** the
   cited line, not merely within the window. The loose version looked like a
   working gate and was mostly a no-op.
2. **A namespace nearly made the gate inert.** Findings carry `static/no-dupe-keys`;
   the premise map was keyed on the bare id, so it matched nothing at all on real
   data while every unit test passed. A gate that cannot fire reads exactly like a
   check that passed — which is why this harness exists.
3. **Loosening the speculation gate was measured and rejected.** Refuting on a
   bare hedge (`may` / `might` / `could`, no hypothetical trigger required) would
   have caught 65 of 136 false positives — and **3 of the 7 true positives**.
   Speculation is not separable from real findings by hedging language alone;
   careful reviewers hedge. The gate stays narrow, and this is why.

**Two further classes were measured and handled differently, on the numbers.**

| Class | FP | TP | Ratio vs ~8:1 base rate | Decision |
|---|---|---|---|---|
| 6 — micro-perf / style restatement | 13 | 1 | better | **demote** out of the inline budget (`lowValueGate`) |
| 5 — wrong language/API claim | 5 | 2 | **worse** | **not built** |

Class 5 is the one this harness stopped. "`for range int` won't compile",
"`bytes.Clone` needs Go 1.20" are exactly the confident-and-wrong findings that
motivate a gate — but the same phrasing carries 2 of the corpus's 29 true
positives. Gating it would trade 7% of all true positives for 2% of false
positives, which is worse than doing nothing. It stays unbuilt, and this row is
why.

Class 6 demotes rather than drops for the same reason at smaller scale: 13:1 is
good enough to stop these consuming inline-comment slots, not good enough to
delete them. Measured effect on the corpora: 9 false positives and 1 true
positive demoted to the summary.

**Recall caveat, stated rather than buried.** Six dropped findings sat within the
scorer's ±5 tolerance of a human comment, so measured recall falls slightly. Both
`injected` cases were audited and are spurious credits: a `no-dupe-keys` finding
was being credited for a planted *inverted-condition* defect, and a
`no-unreachable` finding for a planted *loose-equality* defect. The tolerance was
crediting findings for defects they do not describe, so this removes fake recall,
not real recall. The remaining four on `public-prs` are unaudited.

GATE 2 firing zero times is not evidence it is useless: the corpus predictions are
already post-verification output, and context-line findings were being dropped
upstream. It gates a class adjudication observed, and costs nothing.

#### Lens coverage — the intent-versus-implementation gap

Category precision across both adjudicated corpora, which is what the lens mix
actually buys:

| Lens (`rule`) | Findings | TP | Precision |
|---|---|---|---|
| `general/security` | 106 | 16 | 15.4% |
| `general/correctness` | 86 | 8 | 10.7% |
| `static/no-unreachable` | 26 | 0 | 0.0% |
| `static/no-dupe-keys` | 17 | 0 | 0.0% |
| `general/test-quality` | 16 | 2 | 12.5% |
| `general/performance` | 15 | 2 | 13.3% |
| `general/style` | 6 | 1 | 16.7% |

Security is **39% of everything the reviewer says**. Its precision is not the
problem — at 15.4% it is the best of the large lenses — but the output reads as a
security tool because by volume it is one, while correctness (10.7%) is both
less accurate and less represented.

Every lens hunts a CATEGORY of defect. None asked the question a human reviewer
asks first: *does this code do what it says it does?* That is where the 104
unmatched human threads live. A ninth lens, `intent-implementation`, now asks it
— name versus body, comment versus code, test title versus assertion, PR intent
versus diff, a parameter accepted and never read. It can demand hard evidence
because the diff carries BOTH halves: the finding must quote the claim and the
contradicting line, or it is not reportable.

The `concurrency-correctness` and `api-contract` lenses gained the evidentiary
demand `systemic` already carried — name the concrete input, interleaving or
caller that breaks, or do not report it.

**These prompt changes are UNMEASURED.** Gates are pure functions and replay for
free; a lens change requires re-running the reviewer over the corpus with a real
key and real tokens. Nothing above should be read as a demonstrated improvement
until `node eval/run.js && node eval/score.js --corpus eval/corpus/public-prs.json`
has been re-run and the categories re-adjudicated. The rationale is measured; the
effect is not.

#### Still open

1. **Precision has an LLM-adjudicated figure now, not a human-adjudicated one.**
   All 272 findings across both corpora were judged against their diff hunks by
   four independent LLM adjudicators (see the "LLM-adjudicated precision" section
   above for the numbers). That is a real measurement of *something* — it is not
   the authoritative precision figure. `Precision (human)` is still `n/a` (0/0) on
   both corpora, `--write-baseline` still refuses to anchor the gate on an
   LLM-adjudicated sample, and the gate stays exactly where it was: unanchored
   on precision until a human adjudicates a sample. Use `eval/adjudicate.js`,
   and see its own warning about why an LLM verifying its own kind of finding is
   the failure mode this harness exists to catch.
2. **The convention miner shipped in the product, but this harness still never
   exercises it.** `ConventionMiner` now has two production triggers (index
   completion and PR-page detection) and a review-path integration that awaits
   an in-flight mine before falling back — so a real review of a repo with
   enough history gets its own team's conventions, including on a first review
   if warming had a head start. `eval/run.js`, however, never touches
   `ConventionMiner` at all: it builds a review call directly and does not warm,
   await, or render a convention block. So "the convention miner contributes
   nothing to the run being measured" remains true of THIS EVAL HARNESS
   specifically — it is not a claim about the reviewer, which no longer holds.
   Wiring a harness hook for this is real scope beyond adding the trigger itself
   and remains open follow-up work.

## Building a corpus

1. Pick MRs that were reviewed by humans and are already merged — you need the
   human comments as ground truth.
2. Run RepoSpector on each and export `verifiedFindings`.
3. Adjudicate each finding. Judge against the diff, not against whether the
   comment sounds plausible; the whole reason the LLM verifier was retired is
   that plausibility and correctness came apart.
4. Two adjudicators where you can afford it. A split counts as
   `true_positive` — the conservative reading of disagreement is "worth saying".

## Privacy

`eval/corpus/` and `eval/results/` stay gitignored: they contain proprietary
diffs and internal review comments. Only the harness, the synthetic fixture and
the baseline are committed. Do not commit a corpus, and do not paste real
findings into this README.

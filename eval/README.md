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

#### Still open

1. **Precision is unmeasured.** 126 findings across 129 files is real volume now,
   so a bad precision rate would show as noise. Neither benchmark answers it:
   injected-defect precision would need every non-planted finding adjudicated
   too. Use `eval/adjudicate.js`.
2. **The convention miner is the highest-leverage remaining component, and it is
   cold on a first review.** `ConventionMiner` needs the repo's own past review
   comments; on an unindexed repo it mines in the background and contributes
   nothing to the run being measured. That is exactly the class of comment
   dominating the 104 misses.

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

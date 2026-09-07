# Graph-impact findings

**Module:** `src/services/GraphImpactFindingsService.js` · **Setting:**
`reviewSettings.graphFindings` (default on; pinnable by an org tier via
`.repospector.yaml`)

## The problem

The code graph knew three things a diff cannot show — who calls a changed
symbol, how risky it is to touch, and which dependents have no test — and told
the reviewer about them only as prose pasted into the prompt
(`ReviewGraphContextService`). Whether that prose became a finding was up to
the model. On the benchmark it mostly did not.

## What it does

For every symbol the diff declares in a non-test file, three deterministic
rules run against the in-memory graph:

| Rule | Fires when | Severity |
|---|---|---|
| `graph/signature-changed-callers` | The `-`/`+` declaration lines differ in parameters in a way callers cannot survive (removed, reordered, or new required parameter) **and** the graph has CALLS edges from files this PR does not touch. | high |
| `graph/high-risk-symbol` | `ImpactAnalyzer.quickSafetyCheck` rates the symbol `high` **or `critical`**. Emitted as an **escalation** (`needsHumanReview`, expertise `architecture`) — a question, not a defect claim. | medium |
| `graph/untested-blast-radius` | `findUntestedInBlastRadius(symbol, depth 2)` returns dependents with no `TESTED_BY` edge. | low |

Findings carry `source: 'graph'`, `tool: 'code-graph'`, the caller list as
`evidence`, and skip the LLM refuter the same way static findings do
(`FindingVerificationService`). Inline comments are marked *code graph*; the
persistent summary gets a *From the code graph* section that also states a
clean result. Output is capped at 6 findings per review, highest severity
first, and the cap is reported.

## What it deliberately does not claim

An appended parameter with a default, optional marker or rest form is treated as
compatible, so it stays silent. Anything else — a removal, a reorder, a new
required parameter — is treated as breaking. A symbol not in the graph
(unsupported language, stale index) yields nothing at all; see
`graphCoverage.js` for the warning that covers that case. The `medium` and `low`
risk tiers are deliberately NOT escalated — only `high` and `critical` are, so
that the escalation stays rare enough to be worth reading.

## How to turn it off

`reviewSettings.graphFindings: false`, or `--no-graph-findings` in the eval
harness.

## How to measure

`eval/lib/graphContext.js` builds a graph per corpus case from that case's own
`fileContents`, using the regex symbol extractor (there is no tree-sitter in
Node). It does resolve calls across files, so the signature rule is measured
end-to-end rather than only in unit tests.

Two fidelity notes, both deliberate:

- **The graph is smaller than production's.** Callers exist only in files the
  corpus actually fetched, so the harness *understates* this ability. The
  per-case `graphStats` record reports how many files, nodes and call edges the
  graph really had, so a thin case is visible as a number rather than as an
  unexplained score.
- **Findings enter after the gates.** The harness injects them at the same point
  the shipped handler does — after `verifier.verify()`, before the diff-scope
  filter. Routing them through the citation and evidence gates instead would drop
  them (those gates judge model assertions, and a graph finding cites no
  model-style evidence) and `normalizeStaticFinding` would relabel
  `source: 'graph'` to `'static'`. Either would make the harness describe a
  reviewer that does not ship.

Turn the graph off in a run with `--no-graph-findings`.

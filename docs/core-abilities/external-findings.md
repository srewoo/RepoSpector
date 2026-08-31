# External scanner findings

**Modules:** `src/utils/externalFindings.js` (parse), `src/services/ExternalFindingsService.js` (fetch)
**Setting:** `reviewSettings.externalFindings`, `reviewSettings.checkAnnotations`

## Why this is the highest-credibility finding a review can carry

Every finding RepoSpector produced before this it produced itself: its own
analyzers, or its own model. Both are things the reader has to decide whether to
trust.

A finding from the team's **own** CodeQL, golangci-lint, Trivy or Semgrep run is
categorically different. It cannot be hallucinated. It carries a rule id and
usually a documentation URL. And the people reading the review already trust the
tool that produced it — the review is not asking for new trust, it is relaying a
verdict they already accept.

reviewdog's insight is that the **format** is the integration point. It does not
integrate with linters; it accepts their output. Support SARIF 2.1.0 and rdjson
and you support every scanner a team already runs, with no adapter per tool.

## Three sources

| Source | Setup | Why it exists |
|---|---|---|
| GitHub check-run annotations | none | Every CI check that annotates already exposes these — reviewdog's own `github-pr-check` reporter, CodeQL uploads, Actions problem matchers. Works out of the box, which is why it is the default. |
| A declared CI artifact | `.repospector.yaml` | GitLab has no annotations equivalent. And a SARIF file carries rule URLs and CVSS scores that annotations flatten away. |
| A report handed over directly | `options.externalReports` | The escape hatch for a scanner that runs on someone's laptop. |

```yaml
# .repospector.yaml
externalFindings:
  - job: sast                     # optional; else the most recent job with artifacts
    path: gl-sast-report.json
    format: sarif                 # optional; sniffed when omitted
```

Declaring artifacts **disables** the annotations source, because the same scanner
usually produces both and ingesting each would report every finding twice with
different metadata. The artifact is the richer of the two, so it wins.

The artifact is always taken from the pipeline for the **head SHA under review**.
One from an older pipeline describes code that is not in this diff, and its
findings would land on lines that have since moved.

GitHub artifact ZIPs are deliberately not supported: an MV3 service worker cannot
unpack one without shipping an inflate implementation, and GitHub users already
have annotations, which need no configuration at all.

## What it does with a report

- **Severity** from `security-severity` (CVSS bands) in preference to `level`,
  because most tools leave `level` at `warning` for everything.
- **Rule URL** from `helpUri` (SARIF) or `code.url` (rdjson) — the credibility
  payload, rendered as a link in the posted comment.
- **CWE** from SARIF tags, normalised from `cwe-089` to `CWE-89` so it matches
  what RepoSpector's own analyzers emit. Two spellings of one id would defeat
  every dedupe that keys on `cwe`.
- **Fixes** from rdjson `suggestions` — a deterministic fix from the tool that
  found the problem beats a model's suggestion for the same thing.
- Marks every finding `source: 'external'`, `deterministic: true`,
  `confidence: 1.0`, with an `attribution` string the comment renders.

## Where they enter the pipeline

Twice, on purpose:

1. **Into the review prompt**, merged into `staticResult.findings`. The prompt
   already asks the model to validate pre-detected findings and to find what they
   missed.
2. **Back in after the precision gate.** That gate exists to demand evidence from
   findings a *model* asserted. A CodeQL match is not an assertion — judging it by
   the model-output standard would suppress the most credible findings in the
   review. Re-adding them after the gate (rather than exempting them inside it)
   keeps the gate's own logic about one kind of input. Same pattern, and the same
   reasoning, as the cross-repo findings.

## Trust boundary

A SARIF file arrives over the network from a CI job configured by the repo, which
on a public repo means **attacker-controlled content**. Everything in the parser
treats it as hostile:

- paths that escape the repo (`../../etc/passwd`, `/home/runner/...`, any non-`file:` scheme) are rejected;
- `helpUri` is dropped unless it is `http(s)` — it is rendered as a link;
- messages, rule ids and paths are length-capped; findings are capped at 500.

A malicious report's worst case is that it wastes a slot.

## Reported as

`reviewQuality.externalFindings` — every source, whether it was read, what it
contributed, and the error if not. Failures are always listed: a review that
silently lost its CodeQL findings looks identical to one where CodeQL found
nothing, and the second is a much stronger claim.

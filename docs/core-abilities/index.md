# Core abilities

One page per mechanism, describing what it does, why it exists, and how to turn
it off. The bar for a page here is that it explains a decision someone would
otherwise have to reverse-engineer from the source.

| Ability | What it does |
|---|---|
| [Dynamic context](dynamic-context.md) | Grows each hunk out to the function or class that encloses it, instead of pasting whole files. |
| [Diff budget](diff-budget.md) | Reserves room for the model's response, strips hunks that only delete, and names the files it could not show. |
| [Call budget](call-budget.md) | A hard ceiling on LLM calls per review, with priority tiers so a cosmetic pass cannot starve the review. |
| [Config precedence](config-precedence.md) | The layered resolution of review settings, including an organization tier that can pin a key. |
| [External findings](external-findings.md) | Ingests the team's own scanners (SARIF / rdjson / check annotations) as deterministic, rule-linked evidence. |
| [Filter mode](filter-mode.md) | A named, testable policy for which lines a finding may be reported on — and honest reporting when one is moved. |
| [Fail level](fail-level.md) | The declared severity at which a review blocks a merge, separate from what it reports. |
| [AWS Bedrock provider](bedrock-provider.md) | SigV4-signed access to Bedrock's whole catalogue via the Converse API, with live model listing. |
| [OpenRouter & NVIDIA NIM providers](gateway-providers.md) | One key in front of many vendors' models over the OpenAI wire format, with live listing and vendor-pathed model ids. |
| [Model tiering](model-tiers.md) | A cheaper model for the stages that restate rather than analyse. |
| [Graph-impact findings](graph-impact-findings.md) | Signature changes with un-updated callers, high-risk symbols, and untested blast radius, as deterministic findings rather than prompt text. |
| [PR-scoped test generation](pr-test-generation.md) | Writes tests for the exported symbols a PR adds without coverage, appending to the repo's existing test file and using real call sites from the code graph, gated by syntax and quality validators. |
| [SARIF output & persistent summary](sarif-output.md) | Emits findings as SARIF for GitHub code scanning; keeps one summary comment per PR, updated in place. |
| [PR tools](pr-tools.md) | `/labels`, `/add-docs`, `/ask-line`, `/history`. |

## Prior art

Dynamic context, the diff budget and the call ceiling are all taken from
[pr-agent](https://github.com/The-PR-Agent/pr-agent), whose `pr_processing.py`
solved these problems first. External-findings ingestion, the filter modes and the
fail level come from [reviewdog](https://github.com/reviewdog/reviewdog) — its
insight that the output FORMAT is the integration point is the reason a team's own
CodeQL run can now be first-class evidence here. Model tiering comes from
coderabbit's ai-pr-reviewer, and the "relocated, not silently moved" rule from
[herdr-reviewr](https://github.com/persiyanov/herdr-reviewr). Where the implementations differ, the difference is
noted on the page — usually because RepoSpector has a tree-sitter symbol table
and an indexed repo to work from, and can be exact where pr-agent has to guess.

Two things RepoSpector does NOT take from pr-agent, for the record: its
single-pass JSON review (RepoSpector's `MultiPassReviewEngine` plus the
deterministic evidence gates in `src/utils/*Gate.js` replace it), and its
sort-files-by-token-count ordering (`FileGroupingStrategy` ranks by risk, which
is a better signal).

## Measuring any of this

Every claim on these pages should be checkable against `eval/`:

```bash
node eval/run.js --corpus eval/corpus/injected.json
```

See `eval/README.md` for what the two benchmarks measure and why the numbers
differ so much between them. Note the caveat recorded in
`src/utils/reviewContextBudget.js`: the harness does not yet supply
`ragContext`/`graphContext`/`fileContext`, so context-budget A/Bs through it are
currently inert. Dynamic context is affected by the same gap — it needs
`fileContext` to have anything to expand into.

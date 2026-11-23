# Regression golden set

30 public GitHub PRs that were merged and later reverted or fixed because they introduced a defect. Each case has one golden comment: what a reviewer should have said on the original PR. Built 2026-11-18.

**What it measures: recall only.** Each PR has one known bug. Other real bugs in the same PR are not labelled, so a reviewer's precision on this set is meaningless. Report recall (and recall by severity), not precision or F1.

## Rules (fixed before searching)

1. Original PR merged between 2025-07-01 and 2026-10-31, at most 1,500 changed lines, buggy code in TypeScript/TSX, Python, Go, Java or Ruby.
2. A later merged PR reverts or fixes it and names the original PR (or its commit) as the cause of a bug.
3. The defect is in lines the original PR added, changed or removed. Excluded: reverts for product or process reasons, flaky tests, CI/build/config, dependency bumps, docs-only, test-only, performance without a code defect, and defects caused by a later unrelated change.
4. One golden comment per case, written as a reviewer would have written it on the original PR: where, what breaks, when. No hindsight (no fix, revert or issue references).
5. Severity on Martian's scale: Critical (security, data loss, core crash), High (feature broken in common use), Medium (wrong in a specific realistic case), Low (minor).
6. Mix: TypeScript 8, Python 7, Go 6, Java 5, Ruby 4. No repos from the Martian set (cal.com, discourse, grafana, keycloak, sentry). At most 3 cases per repo.

## Process

- Search: one agent per language read GitHub with `gh` (read-only), starting from revert PRs and fix PRs that cite an earlier PR ("introduced in", "regression", "caused by"). About 120 candidates were inspected in detail; most were rejected under rule 3 (process reverts, no named cause, dependency or CI origin) or rule 1 (too old, too large).
- Verification: a separate agent per batch, which had not done the search, re-checked every case against the fix PR and the original diff, and was told to look for reasons to drop or correct. Outcome on the first 30: 22 kept, 7 corrected (mostly bundled second claims removed, or severity lowered), 1 dropped (vercel/next.js#97821: defect only visible through deployment-adapter internals). One replacement was searched and verified the same way.
- `verification.json` records each verdict and reason, and the comment as originally proposed.
- `evidence` in each case gives the fix PR, a quote naming the cause, and the original lines.

## Known limits

- Labels come from model agents reading PRs, verified by a second agent, not by the projects' maintainers. Expect a few comments that are imprecise; `verification.json` shows where corrections were made.
- `original_locations` line ranges come from the PR head or diff hunks and can be approximate.
- Some cases need repository knowledge beyond the diff (for example airflow#72173: methods that do not exist on the class). That is intentional: it is the kind of bug code-graph context should help with.
- Recent PRs reduce, but do not remove, the chance that a model saw the fix in training.

## Use

```sh
node packages/eval/dist/martian-cli.js import --regressions --golden-dir eval/data/regressions --out eval/data/regressions/cases.json
node packages/eval/dist/martian-cli.js baseline --cases eval/data/regressions/cases.json --run eval/runs/regr-baseline-sonnet
node packages/eval/dist/martian-cli.js judge --cases eval/data/regressions/cases.json --run eval/runs/regr-baseline-sonnet
```

`import --regressions` reads only `golden*.json` from the directory, so `verification.json` and the generated `cases.json` can sit beside it.

All 30 cases are held out: none is used to tune prompts.

# Diff budget

**Module:** `src/utils/diffBudget.js` · applied in `MultiPassReviewEngine`

Three separate leaks, all of which pr-agent's `pr_processing.py` had already
closed.

## 1. Deletion-only hunks

A hunk that only removes lines has nothing to review. The prompt already tells
the model never to report a finding against a removed line, so those tokens buy a
restatement of a rule it was already given. On a refactor or a file move they are
most of the diff.

`stripDeletionOnlyHunks` drops them. It is deliberately narrow: a hunk with even
one added line stays whole, because a `-`/`+` pair is a *modification* and the
removed side is what makes the change legible ("this used to check for null").

A file whose every hunk is deletion-only is reported by name instead of being
rendered as an empty diff block — "here is the diff:" followed by nothing reads
as a fetch failure.

## 2. No output reserve

The context window was being treated as available for input. When a large diff
filled it, the model had no room left to answer, and the response came back
truncated — which surfaces as a JSON parse failure. That is a review which had
all the context it needed and produced *nothing*.

`fitFilesToBudget` reserves `softReserveTokens: 4000` for the response and stops
adding files below it, with a hard floor at `2500`. pr-agent uses 1500/1000;
RepoSpector's numbers are higher because it asks for a much larger JSON object
per file (findings with `evidence`, `suggestedFix`, a per-file verdict). A
truncated response costs an entire review unit; an omitted file costs one file.

There is also `maxDiffShare: 0.6` — a cap on the share of the window that diff
text may occupy, so the retrieved repo context, the graph slice and the standards
block cannot all be crowded out by one enormous file.

**Order is the caller's.** pr-agent sorts files by token count descending. This
does not re-sort: `FileGroupingStrategy` already ranks review units by risk, and
that is a better signal than size.

## 3. Silent dropping

When files did not fit, they simply were not mentioned. The model then believed it
had seen the whole change and reasoned accordingly — "this caller is never
updated" about a caller that *is* updated, in a file it was not shown.

`renderOmittedFiles` lists them by name, with churn counts and a deleted-files
section, under an instruction not to infer anything from their absence. It costs
a handful of tokens and converts a confidently wrong answer into a stated
limitation. This is the same failure `HunkWindower`'s rule 3 guards against, one
level up.

## Configuration

Not user-facing. The constants are in `DIFF_BUDGET_DEFAULTS`; the window size
comes from `tokenManager.getModelLimit(model)`.

## Reported as

Logged per review unit: `✂️ Diff budget: showing 3/7 file(s) of this unit
(4,182 diff tokens, 2 deletion-only hunk(s) stripped)`.

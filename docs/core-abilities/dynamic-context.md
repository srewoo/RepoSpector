# Dynamic context

**Module:** `src/utils/dynamicContext.js` · **Setting:** Review Quality →
*Expand Hunks to Enclosing Function* (`reviewSettings.enableDynamicContext`)

## The problem

A unified diff carries three lines of context on each side of a change. That
number was chosen for humans scrolling a patch; it has nothing to do with the
structure of the code. Three lines routinely cuts a function's guard clauses off
the top of a change to its body, and just as routinely pads a one-line config
edit with noise.

RepoSpector's earlier answer was `ReviewFileContextService`: fetch the whole
post-change file and paste it in. For a 200-line file that is strictly better
than a hunk and costs almost nothing. For a 2,000-line file with a 12-line
change, it is 1,988 lines of haystack — and `src/utils/reviewContextBudget.js`
records the eval finding that misses concentrate in exactly those large files,
read as attention dilution rather than a rule gap.

`HunkWindower` answered half of that by splitting large diffs into windows. This
is the other half.

## What it does

For each hunk, find the innermost declaration containing it and grow the hunk out
to that declaration's bounds, subject to a ceiling. Then merge hunks whose
expanded ranges touch, so no line is emitted twice.

Two properties are deliberate:

- **Asymmetric.** More context before the change than after
  (`extraLinesBefore: 3` vs `extraLinesAfter: 1` when there is no enclosing
  declaration). The code preceding a change is what explains it.
- **The declaration is a boundary, not just a target.** Expansion never reaches
  past the enclosing function, even when the fixed window would have. A change on
  the second line of a function is within three lines of the *previous*
  function's closing brace; including that tail spends tokens and blurs where the
  reviewed unit begins.

Where pr-agent scans backward heuristically for a boundary
(`max_extra_lines_before_dynamic_context: 8`), RepoSpector reads the exact
start/end lines from `SymbolExtractor` — the same declaration ranges that form
the node layer of the knowledge graph. The boundary is a lookup, not a guess.

## When it runs

Only for files where it beats the alternative:

| Situation | Strategy |
|---|---|
| File ≤ 400 lines | Whole file. Cheap and strictly more informative. |
| File > 400 lines, content verifies | Expanded hunks. |
| Content truncated or mismatched | Whole file (or patch only) — expansion refused. |
| `.md`, `.txt`, `.json`, `.csv`, lockfiles… | No expansion (`skipTypes`). |

## The two invariants

**1. The expanded patch is for reading only.** Inline-comment validation
(`patchLines.commentableLines`) keeps using the original patch. A host rejects a
comment on a line outside its own diff, and GitHub 422s the *entire* review when
one comment is invalid — losing every comment, not just the bad one. Expansion
therefore never replaces `file.patch`; it produces a separate string used only
when rendering the prompt. The test
`keeps the added line addressable` pins this.

**2. Expansion is refused unless the file content verifiably matches the patch.**
`verifyAlignment` checks every context and added line the patch claims against
the same line number in the file. A single mismatch fails the whole file.

That second rule is doing more work than it looks like. `fullContent` can be
truncated to fit `maxBytesPerFile`, or fetched at the wrong ref — GitLab's file
API defaults to the *target* branch, which is the code before the MR. Prepending
lines from the wrong version of a file hands the model fabricated context that it
cannot identify as wrong and will reason from confidently. Three lines of git
default is a much better failure than that.

## Configuration

```yaml
# .repospector.yaml
settings:
  enableDynamicContext: true
```

Defaults live in `DYNAMIC_CONTEXT_DEFAULTS`: `extraLinesBefore: 3`,
`extraLinesAfter: 1`, `maxExtraLinesBefore: 12`, `maxExtraLinesAfter: 6`,
`mergeGap: 6`.

## Reported as

`reviewQuality` does not carry expansion stats directly; the prompt builder emits
them through `onContextStats` (`{expandedFiles, fullFileFiles,
deletionOnlyHunksRemoved}`) and the engine logs them. A prompt that used expansion
says so in its own text, so it is also visible in any captured prompt.

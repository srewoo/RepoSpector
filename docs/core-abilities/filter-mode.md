# Filter mode

**Module:** `src/utils/findingFilterMode.js` · **Setting:** Review Quality →
*Where Findings May Be Reported* (`reviewSettings.filterMode`, default `added`)

## The problem it fixes

RepoSpector already filtered findings to the diff, in three places that each knew
part of the rule:

| Where | What it did |
|---|---|
| `FindingsNormalizer` | dropped findings outside the assigned hunks, snapping near-misses |
| `patchLines.commentableLines` | allowed added **and** context lines |
| `inlineCommentFormatter` | `snapToCommentableLine(line, allowed, 5)` |

Stack those and the actual promise was *"added, or context, or within five lines
of either."* That is materially weaker than what any reviewer assumes when a bot
comments on their line — and it was stated nowhere.

reviewdog states it, as `-filter-mode`. **Naming the policy is itself the
credibility feature**: "we only report on lines your PR added" is a claim you can
publish and a test can hold you to.

## The four modes

reviewdog's names, so a team that knows reviewdog needs no new vocabulary.

| Mode | Scope | Snap window |
|---|---|---|
| `added` (default) | lines this PR added | 2 |
| `diff_context` | added lines and their diff context | 5 |
| `file` | anywhere in a changed file | 0 |
| `nofilter` | anywhere | 0 |

An unrecognised value falls back to `added`, never to `nofilter`: a typo must not
silently widen the scope to the whole repository.

`added` gets a snap window of 2 rather than 0 because the off-by-one failure is
real — models name the function header instead of the body — and a two-line move
is still inside the changed region. Larger than that stops being a correction and
starts being a guess about where the defect is.

## Relocation is reported, never silent

This is the honesty half, and it is borrowed from herdr-reviewr's principle that a
comment whose lines shifted should be marked **stale rather than silently
dropped** — applied here to where RepoSpector actually has drift.

A moved finding carries `relocated: {from, to, distance}`, and
`buildCommentBody` renders it:

> _(reported on line 41; moved 2 line(s) to the nearest line in the diff)_

Moving a comment onto a line nobody chose and staying quiet about it is a small
dishonesty that compounds: the reviewer reads a precise line number that no part
of the system actually asserted.

## Nothing disappears silently

`applyFilterMode` returns `kept` and `dropped` separately, with a reason on every
drop, and `stats` accounts for every finding it was given. The review renders
`describeFilterMode(stats)` **whether or not anything was dropped** — a reviewer
who knows the scope can tell the difference between "clean" and "out of scope",
which is the difference between trusting the tool and being surprised by it later.

## Reported as

`reviewQuality.filterMode` (stats), `filterModeNote` (the sentence),
`filterModeDropped` (what was excluded and why).

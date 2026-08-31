# Fail level

**Module:** `src/utils/failLevel.js` · **Setting:** Review Quality →
*Block the Merge At* (`reviewSettings.failLevel`, default `high`)

## The problem

The rule was one line:

```js
const blockingEvent = multiPassBlocking > 0 ? 'REQUEST_CHANGES' : null;
```

A hardcoded policy dressed as an implementation detail, with two consequences:

1. **Reporting and blocking were the same decision.** A team could not say
   "comment on everything, block only on security" — the only lever was the
   severity threshold, which changes what gets *reported*. So the only way to stop
   blocking on a medium finding was to stop seeing medium findings entirely.

2. **The threshold was never declared.** `blocking` comes from the finding's own
   severity, which the model assigned. Making a merge-blocking decision from a
   self-declared field with no stated threshold is exactly what erodes trust the
   first time it blocks a PR over a style nit.

reviewdog separates the two with `-fail-level`. This is that.

## Levels

`none` · `critical` · `high` (default) · `medium` · `low` · `info` · `any`

The default reproduces the previous behaviour exactly: blocking findings are
assigned `high`/`critical`, so `high` blocks on precisely what
`multiPassBlocking > 0` blocked on. A configurable knob whose default changes
behaviour is a migration, not a feature.

An unrecognised value falls back to `high`, never to `none`: a typo must not
silently disable a team's merge gate.

## Two classes of finding, judged differently

```js
if (finding.deterministic === true) return true;   // severity alone
return finding.blocking === true;                  // must also be marked blocking
```

A **deterministic** finding — RepoSpector's own analyzers, or an ingested scanner
report — is judged on severity alone. A scanner either matched or it did not.

An **LLM** finding must also have been marked blocking by the pipeline that
produced it. It has already been through the evidence gates and verification, and
one that failed those has no business blocking a merge however severe it claims to
be.

## One decision, two expressions

`verdict` and `reviewEvent` both come from a single `decideFailure()` call. They
were previously two independent expressions of the same rule, which is one edit
away from contradicting each other.

## Enforceable

`failLevel` is in `configPrecedence.ENFORCEABLE_KEYS`. "Security findings block,
and no repo may lower that" is a statement about how a team ships, not a personal
preference — and it is not enforceable unless an org can pin it.

## The gate explains itself either way

`describeFailLevel` renders whether or not it fired:

> Merge gate: passed — no finding at or above high (threshold: high).

A gate that only speaks when it fires leaves the reader guessing what would have
fired.

## Reported as

`reviewQuality.failLevel` — `{level, blocks, reason, blockingCount}` — plus
`failLevelNote`.

# Call budget

**Module:** `src/utils/callBudget.js` · **Setting:** Review Quality →
*Max AI Calls per Review* (`reviewSettings.maxAiCalls`, default 60, `0` = no limit)

## The problem

The pipeline's call count is a **product**, not a sum:

```
review units  =  chunks (MRChunker)  ×  windows per large file (HunkWindower)
calls         =  review units  +  1 aggregation
                 +  verification batches  +  scoring batches
                 +  finder lenses  +  exploration turns  +  fix recommendations
```

Every one of those limits is local and reasonable. Nothing bounded the product. A
60-file MR with three 900-line files could quietly issue several hundred calls,
and the user discovers the number on their provider bill — RepoSpector is BYOK, so
this is real money, not a quota.

pr-agent caps this with `max_ai_calls` and degrades when the cap is hit.

## Two differences from pr-agent

**Enforced at one choke point.** The ceiling lives in `LLMService.callLLM`, not at
each call site. A budget that every new pass has to remember to check is a budget
that leaks the first time someone adds a pass.

**Stages declare a priority.** A flat cap has a failure mode of its own: it can
spend the last of the allowance on a re-ranking pass and then refuse the review
unit that would have produced the findings being ranked.

| Priority | Stages | May spend |
|---|---|---|
| `essential` | `per-file`, `aggregate`, `finder`, `line-question` | the whole budget |
| `important` | `verify` | the whole budget |
| `optional` | `scoring`, `fixes`, `explore`, `docstrings` | down to a 15% floor |

## Exhaustion is not an error

`tryConsume` returns `false`; `callLLM` throws a `CallBudgetExceededError`, which
`LLMService.isBudgetError` identifies. The stage that asked is skipped, the review
completes with what it has, and the shortfall is reported. Throwing an outage
would turn a cost control into a failure mode.

Two things it deliberately does not do:

- **Retries are not metered.** `withRetry` wraps the dispatch *inside* `callLLM`,
  so one logical call costs one unit however many times the transport is
  replayed. Metering retries would let a flaky provider eat a whole review budget.
- **It never grants a partial allowance.** A verification batch given half its
  calls reports half its findings as unverified, which reads as "verified clean".
  A caller that can genuinely use less should ask `availableFor(priority)` first.

## Lifecycle

`LLMService` is a singleton on the background worker, so the budget is armed
per-review and cleared in a `finally` — including on a throw before the review
started. A stale budget would meter the user's next chat message against an
exhausted review allowance.

An LLM client without `setCallBudget` (a test double, a future replacement) is
tolerated, but loudly: the handler warns that the review is **not metered**. A
silently unmetered review is exactly the runaway this exists to prevent.

## Configuration

```yaml
# .repospector.yaml — note: an org policy may NOT pin this key
settings:
  maxAiCalls: 40   # 0 disables the ceiling
```

`normalizeMaxAiCalls` clamps to [5, 500] and falls back to the default for
unreadable input — a typo must not silently remove the guard. An explicit
non-positive number means "off".

`maxAiCalls` is deliberately absent from `ENFORCEABLE_KEYS` in
`configPrecedence.js`: an organization pinning how much of someone's own API
budget a review may spend is a lockout, not a policy.

## Reported as

`reviewQuality.callBudget` — `{limit, used, remaining, byStage, refusals}` — plus
`reviewQuality.callBudgetNote`, one line naming the skipped stages, which is
non-null only when the ceiling actually got in the way.

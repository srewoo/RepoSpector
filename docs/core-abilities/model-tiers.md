# Model tiering

**Module:** `src/utils/modelTiers.js` · **Setting:** Review Quality →
*Light Model* (`reviewSettings.lightModel`, empty by default)

## Why

Every LLM call used one model. But the calls are not remotely alike:

| Call | Needs the best model? |
|---|---|
| Finding a race condition in a 200-line diff | yes |
| Deciding whether a finding is real | yes |
| Summarising a PR whose findings are already known | no |
| Re-ranking findings by reviewer value | no |
| Writing a docstring for a function you can see | no |

coderabbit's ai-pr-reviewer splits this into a light and a heavy model. The
accuracy argument is indirect but real: the reason *not* to run the expensive
model on the review pass is cost, and the cheapest way to buy that headroom is to
stop paying it for summarisation and re-ranking. The non-review passes are
roughly a third of the calls on a typical review.

## The rule for the table

Does the stage **decide whether a finding is real**, or does it present findings
someone else decided on? Deciding is heavy.

| Heavy | Light |
|---|---|
| `per-file`, `finder`, `verify`, `explore`, `line-question` | `aggregate`, `scoring`, `fixes`, `docstrings`, `summary`, `pr-description`, `changelog`, `labels`, `convention` |

Two entries worth defending:

- **`verify` is heavy.** It decides whether a finding survives to be posted.
  Running it on a weaker model than the one that generated the finding means the
  refuter is outmatched by the thing it is refuting — and the failure mode is a
  false positive reaching the reviewer, which costs far more than the call it
  saved.
- **`aggregate` is light** despite writing the review narrative: by then every
  finding is fixed, cited and verified, and the call is composition.

## Conservative by default

With no light model configured, every tier resolves to the single configured
model and nothing changes. A tiering scheme that silently downgraded the review
pass would trade accuracy for cost without asking, which is the opposite of the
point.

An **unknown** stage resolves to heavy, so a pass added later is never silently
downgraded because nobody remembered to list it.

## One gotcha it handles for you

`settingsForStage` drops `provider` when the light model carries its own prefix.
`resolveModel` requires an explicit provider to *agree* with a prefix, so passing
`provider: 'openai'` alongside `model: 'anthropic:claude-3-haiku'` is a hard
error — which is exactly the mistake someone makes when they pick a light model
from a different provider and leave the provider field alone.

## Reported as

`reviewQuality.modelTiering`, or `null` when tiering is not in use — nothing is
said about a feature nobody turned on.

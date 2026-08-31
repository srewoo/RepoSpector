# Config precedence

**Module:** `src/utils/configPrecedence.js`

## The problem

Review behaviour is configurable from four places, and the merge used to be a
spread —

```js
const rqCfg = { ...reviewSettings, ...customConfig?.settings };
```

— followed by a scatter of `rqCfg.x !== false && options.x !== false` tests at
each use site. Two things were wrong with that:

1. **The order was implicit.** "Why did verification run when I turned it off?"
   could only be answered by reading the call site.
2. **`&&` is a veto, not an override.** Under that idiom any layer could turn a
   feature off and *no* layer could turn it back on. A repo enabling something the
   user had disabled stayed disabled, silently.

And there was no organization tier at all — nowhere for "inline comments always
post, and no repo may switch that off".

## The chain

Lowest to highest:

| Layer | Source | Rationale |
|---|---|---|
| `defaults` | in code | |
| `user` | extension Settings | one person, one machine |
| `org` | `settings.orgPolicy` | organization policy |
| `repo` | `.repospector.yaml` `settings:` | reviewed, versioned, per-project |
| `call` | slash-command flag, panel toggle | explicit and momentary |

`repo` above `user` is deliberate and preserves the previous behaviour: a
committed config represents a team decision, Settings represents one person's
machine.

Only **own, defined** keys of a layer participate. `{verifyFindings: undefined}`
is silence, not an instruction — which is what makes a partially-filled `call`
layer safe to pass in whole.

## Enforcement

An org layer may carry `enforce: ['key', ...]`. A pinned key ignores `repo` and
`call`, and `provenance` records `org (enforced)` so the UI can explain why a
toggle did not take. An org tier that any repo can override is decoration;
locking is the part that makes it worth having, and it is the part pr-agent's
org-level config leaves out.

`ENFORCEABLE_KEYS` is a **closed list**, covering only what the review *does*:
severity threshold, posting toggles, verification, the analysis passes. An org
naming a key outside it gets a `rejected` entry rather than silence — a team that
believes it locked something it did not is worse off than one that was told no.

Never enforceable: credentials, and `maxAiCalls`. An org that can pin those can
lock a user out of their own key or spend their own API budget for them.

## Credentials

`USER_ONLY_KEYS` — API keys, host tokens, Jira credentials, host lists — are
taken from `user` and nowhere else.

This matters because `.repospector.yaml` is **attacker-controlled content on any
public repo**: it arrives over the network from a project the user merely opened a
PR page for. A repo config that could set `githubToken` or `gitlabHosts` could
redirect the user's credentials to a server it controls.

`model` is intentionally *not* on that list. Pinning a model is an existing,
wanted feature and spends the user's own key on the user's own provider.

## Reported as

`reviewQuality.configProvenance` (key → layer), `configEnforced`, and
`configRejected`. `explainOverrides()` renders those as one line each; the review
handler logs them with a `⚙️` prefix.

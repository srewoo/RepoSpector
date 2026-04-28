# `.repospector.yaml` repo configuration

Drop this file at the root of any repo to override review behavior on a
per-repo basis. RepoSpector fetches it on each PR review (cached for 1 hour).

## Schema

```yaml
# Files and rules to skip entirely.
ignore:
  files:
    - "vendor/**"
    - "**/*.generated.ts"
    - "test/fixtures/**"
  rules:
    - "no-console"
    - "max-line-length"

# Override severity for specific rules.
# Allowed values: critical, high, medium, low, info
severity_overrides:
  no-explicit-any: low
  todo-comment: info

# Add custom regex-based rules. Matched lines become findings.
rules:
  - pattern: "console\\.log"
    severity: medium
    category: cleanliness
    message: "Stray console.log left in code"
  - pattern: "TODO\\(@?\\w+\\)"
    severity: info
    message: "Open TODO with owner — track in tickets"

settings:
  # Drop findings whose severity is below this floor. Useful for noisy repos
  # where you only want signal above a bar. Default: no floor.
  severityThreshold: high

  # Pin the LLM provider/model for this repo, overriding the user's setting.
  # Format: "<provider>:<model>". Example values:
  #   openai:gpt-4.1-mini
  #   anthropic:claude-sonnet-4-6
  #   google:gemini-2.0-flash
  model: openai:gpt-4.1-mini

  # When true (default), the model only flags issues introduced by the diff —
  # not pre-existing problems in surrounding context. Set to false to revert
  # to whole-file review (rarely what you want; expect noise).
  diffAnchored: true

  # Require a minimum confidence (0–1) before a finding is shown.
  minConfidence: 0.6
```

## How it interacts with other settings

| Layer | Wins when |
|---|---|
| `.repospector.yaml` `settings.model` | Always overrides the user's model selection for reviews of that repo. |
| `.repospector.yaml` `settings.severityThreshold` | Applied last in `applyAllRules`, after ignore/severity-overrides/min-confidence. |
| `ignore.files` (glob) | Drops findings whose `filePath` matches any pattern. `**` matches any number of segments; `*` matches a single segment. |
| `ignore.rules` (rule IDs) | Drops findings with a matching `ruleId`. |
| `severity_overrides` | Rewrites a finding's severity, then the threshold filter sees the new value. |

## Telemetry

Local-only review metrics (latency p50/p95, token usage, dismissed-finding
rate) are tracked when **opted in** via the popup settings. Nothing leaves
the browser. Toggle: Settings → "Local telemetry". Clear: Settings →
"Reset telemetry". You can read your numbers via the popup or via the
`GET_TELEMETRY` extension message in devtools.

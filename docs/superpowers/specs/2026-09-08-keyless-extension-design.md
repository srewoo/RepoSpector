# Design — Keyless extension: onboarding, Chrome built-in AI, Ollama zero-config

Date: 2026-09-08
Status: awaiting review
Scope: extension only. The MCP server is a separate spec —
`2026-09-08-repospector-mcp-server-design.md`.

## Why

RepoSpector cannot be used without pasting an API key, and the first screen a
new user sees tells them so: step 1 of the welcome panel
(`src/popup/App.jsx:428`) reads *"Add your API key and select a model in
Settings"*. That is the whole funnel — a user without an OpenAI or Anthropic
key has nothing to try.

Two keyless engines are within reach and one is already half-built:

| Route | State today | Gap |
| --- | --- | --- |
| Ollama (`LLM_PROVIDERS.LOCAL`) | Implemented end to end — `callOllama` (`LLMService.js:951`), `checkOllamaStatus` (`:1228`), settings panel (`Settings.jsx:960`) | Setup instructions omit the step that makes it work; probe misreports failures |
| Chrome built-in AI (Gemini Nano) | Not present | Whole provider missing |

Neither needs a key, a server, or a subscription. This spec closes both gaps
and rewrites onboarding to lead with them.

### The Ollama bug, precisely

`Settings.jsx:976-978` instructs the user to:

1. install from ollama.ai
2. `ollama pull llama3.3`
3. `ollama serve`

Follow those three steps exactly and the extension still cannot reach Ollama.
A `fetch` from an extension page carries `Origin: chrome-extension://<id>`,
which makes it a cross-origin request; Chrome sends a CORS preflight, and
Ollama rejects any origin not named in `OLLAMA_ORIGINS`. The call fails at the
preflight, before the model is ever consulted.

`checkOllamaStatus` then reports this as the server being unreachable, which is
the one diagnosis that is certainly wrong — the server is running and refusing
us. A user who follows the documented steps gets an error blaming a step they
completed correctly, so the natural next action is to give up on the keyless
path and go find a key.

This is the highest-leverage fix in the spec: the code works, only the
instructions and the diagnosis are wrong.

---

## Item 1 — `chrome-ai` provider

### What it is

Chrome 138+ exposes an on-device model (Gemini Nano) to extensions through the
`LanguageModel` global. No key, no network, no permission prompt, no
`host_permissions` entry, and no CSP change — it is an in-process browser API
rather than a `fetch`, so it touches none of the network plumbing the other
eleven providers share.

### Wiring

It follows the Ollama precedent exactly, because Ollama is already the
"provider with no key" case and the code paths are shaped for it:

- `LLM_PROVIDERS.CHROME_AI = 'chrome-ai'` in `src/utils/constants.js`.
- **No** `API_ENDPOINTS` entry. Every other provider has one; this provider has
  no URL at all. The absence is intentional and worth a comment, so the next
  person does not "fix" it.
- `callChromeAI(requestData, options)` on `LLMService`, alongside `callOllama`.
  Signature omits `apiKey`, as `callOllama` and `callBedrock` already do.
- One `case` in `_dispatchToProvider` (`LLMService.js:336`).
- Settings treats it as keyless: extend the existing `isLocalProvider` test at
  `Settings.jsx:607` to a shared `providerNeedsKey(provider)` predicate rather
  than adding a second boolean. Three call sites already branch on this
  (`:439`, `:509`, `:888`) and a fourth flag makes each of them worse.

### Availability is four-state, not two

`LanguageModel.availability()` returns `unavailable`, `downloadable`,
`downloading`, or `available`. The two middle states are the ones that matter:
first use of Nano triggers a multi-gigabyte download, and a provider that
renders "downloading" as a spinner with no end is worse than one that is
honestly absent.

`create()` accepts a `monitor` callback emitting `downloadprogress` events. The
settings panel subscribes and shows real progress. `downloadable` renders as an
explicit "Download model (~2 GB)" action — the user decides, we never start a
multi-gigabyte transfer because someone opened a settings tab.

### Streaming

`session.promptStreaming()` returns a `ReadableStream` of text chunks. It is
**not** a `fetch` `Response`, so `handleStreamingResponse` (`LLMService.js:1021`)
cannot consume it — that method reads `response.body` and parses SSE framing.
`callChromeAI` needs its own small reader that emits through the existing
`sendChunk` (`:1189`), which is the actual contract the popup depends on.

### Sessions are stateful — treat them as per-call

`LanguageModel` sessions accumulate conversation state and have a hard input
quota. RepoSpector's callers pass a full `messages` array each time and expect
statelessness. So `callChromeAI` creates a session, prompts, and calls
`session.destroy()` in a `finally`. Reusing sessions would leak context between
unrelated reviews and exhaust the quota. `initialPrompts` carries the system
message; the rest is flattened into the prompt.

---

## Item 2 — Provider capabilities and task gating

### The problem this solves

Nano's input quota is roughly an order of magnitude smaller than any API
model's. Offered as a peer provider, it would be selected for a 40-file PR
review, chunked into fragments by `MRChunker`, and would return findings with
no cross-file context. The user would read that as RepoSpector being bad, not
as a model mismatch — and they would be reading a truncated prompt's output
without knowing it.

### `src/utils/providerCapabilities.js`

A new module declaring, per provider:

```js
{ maxContextTokens, supportsTools, supportsStreaming, needsKey }
```

Two rules:

- **Nano's context is read at runtime, not hardcoded.** A live session exposes
  `inputQuota` and `inputUsage`. The declared value is a conservative fallback
  used only before a session exists; once one does, the real number wins. A
  hardcoded `6144` becomes wrong the first time Chrome changes it, and it would
  fail silently.
- **Everything else keeps today's behaviour.** Other providers get
  `maxContextTokens: null`, meaning unconstrained. Nothing about the existing
  eleven providers changes. This module exists to make one provider's limits
  legible, not to introduce a budget system.

### Gating

Each task declares a minimum context requirement. `chrome-ai` is advertised for
file and hunk summaries, commit messages, label generation
(`LabelGeneratorService`), docstrings (`DocstringService`), and chat over a
single small file. Full PR review, `MultiPassReviewEngine`, and repo-wide chat
render disabled **with the reason shown** — not hidden. The reason quotes the
live quota rather than a literal, e.g. *"needs ~40k context, this model has
6k"*, so it stays true when Chrome changes the quota.
A disabled control that explains itself teaches the user the shape of the tool;
a hidden one makes them wonder if the extension is broken.

Gating is advisory in the UI and enforced in one place: `callChromeAI` rejects
an over-quota prompt with a typed error naming the task and the overage, rather
than letting the API truncate silently. Silent truncation is the specific
failure this item exists to prevent, so it must not be reachable by a caller
that skipped the UI.

---

## Item 3 — Ollama zero-config

### Corrected instructions

Replace `Settings.jsx:972-980` with four steps, the third being the one that is
currently missing:

1. Install from ollama.ai
2. `ollama pull qwen2.5-coder`
3. Allow the extension's origin:
   - macOS/Linux: `OLLAMA_ORIGINS=chrome-extension://* ollama serve`
   - launchd (macOS service): `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` then restart Ollama
   - Windows: `setx OLLAMA_ORIGINS "chrome-extension://*"` then restart Ollama
4. Verify with **Test connection**

Each command is copy-to-clipboard. Three platforms are listed because Ollama's
env var is set differently on each, and "set an environment variable" is where
a non-Windows-shell user stalls.

`chrome-extension://*` is a wildcard rather than this extension's specific ID
so the instruction survives a reinstall and works for an unpacked development
build. The narrower form is offered as a note for users who want it, with the
actual ID interpolated from `chrome.runtime.id` so it is copy-pasteable.

### Default model

Change the recommended model from `local:llama3.3` (`Settings.jsx:93`) to
`local:qwen2.5-coder`. Llama 3.3 is a general chat model carrying a ~40 GB
download at its common quantisation; qwen2.5-coder is code-specialised and
available in far smaller sizes. For a code-review tool the code model is the
correct default, and it is the cheaper download.

### Probe that distinguishes failures

`checkOllamaStatus` (`LLMService.js:1228`) currently collapses every failure
into "not reachable". Split into four verdicts, each with its own fix:

| Verdict | Signal | Message |
| --- | --- | --- |
| `ok` | `/api/tags` returns, selected model present | Ready |
| `cors_blocked` | `TypeError` on fetch while server is up | "Ollama is running but rejecting this extension — set `OLLAMA_ORIGINS`" + step 3 |
| `not_running` | connection refused | "Start Ollama with `ollama serve`" |
| `model_missing` | tags returned, model absent | "Run `ollama pull <model>`" + the models that *are* installed |

Distinguishing `cors_blocked` from `not_running` is the crux. A blocked
preflight surfaces in `fetch` as an opaque `TypeError` — indistinguishable from
a refused connection by the response alone, since CORS deliberately hides
detail from the page. We separate them by probing `/api/tags` with
`mode: 'no-cors'`: an opaque response proves the server answered, so the origin
is being refused rather than the port being closed. The distinction cannot be
made from the error object, only from that second probe, which is why the
current code cannot make it.

---

## Item 4 — Onboarding

Rewrite the welcome panel (`src/popup/App.jsx:406-440`). Step 1 stops being
"add a key" and becomes a live-probed ranking of what this user can actually
use right now:

```
Ready now      → Chrome built-in AI       [Use it]     (availability === 'available')
Best quality   → Ollama, no key           [Set up]     (~5 min)
Full power     → Bring your own API key   [Add key]
Use from Claude → RepoSpector MCP server  [Copy config]
```

Ordering is by time-to-first-result, not by quality, because the panel's job is
to get the user to one working result. Quality is named in the labels so the
ranking does not mislead: the fastest option is not claimed to be the best one.

Rows are probed, not static. If Nano is `unavailable`, that row states why
(Chrome version, or unsupported hardware) instead of offering a button that
cannot work. If Ollama is already running, its row promotes to "Ready now" and
Nano drops below it — a user with Ollama installed should not be steered to the
weaker engine.

The fourth row appears only once the MCP package is published, and is a
copy-to-clipboard of the JSON config block. It is a pointer, not a feature of
this spec.

### Testability

The probe-and-rank logic is extracted to `src/popup/utils/keylessRoutes.js` as
a pure function from probe results to ranked rows. The panel renders what it
returns. Ranking is the part with actual logic and the part worth testing; it
should not require rendering React to test.

---

## Item 5 — Splitting `Settings.jsx`

`Settings.jsx` is 1795 lines against CLAUDE.md's 300-line ceiling, and Items 1
through 3 all land inside it. Extract per-provider setup panels to
`src/popup/components/settings/`:

- `ApiKeyProviderPanel.jsx` — the nine key-based providers
- `BedrockPanel.jsx` — the four-field AWS credential case
- `OllamaPanel.jsx` — Item 3
- `ChromeAIPanel.jsx` — Item 1
- `providerPanelRegistry.js` — provider → panel

`Settings.jsx` keeps layout, persistence, and the provider/model selects, and
delegates the setup block. This is scoped to the file being edited: no unrelated
refactoring, and the extraction is mechanical enough to verify by inspection.

Doing this is what keeps Item 1 from being "add a fourth conditional block to a
1795-line file". Without it, the two keyless providers make the file worse in
exactly the way the ceiling exists to prevent.

---

## Testing

Per CLAUDE.md every change ships with unit tests. Tests in `test/` are CommonJS
— Babel resolves no presets for that directory, so ESM `import` fails to parse
there.

| Unit | Tests |
| --- | --- |
| `providerCapabilities.js` | pure; table-driven over every provider |
| `keylessRoutes.js` | pure; ranking for each combination of probe results, including all-unavailable |
| Ollama probe classifier | the four verdicts, given faked fetch outcomes; asserts `cors_blocked` is reached via the opaque-response path and never misreported as `not_running` |
| `callChromeAI` | faked `LanguageModel` global: prompt shaping, `initialPrompts` for the system message, streaming through `sendChunk`, `destroy()` in `finally` on both success and throw, typed over-quota rejection |
| `providerNeedsKey` | all providers; guards the three existing branch sites |

Panels extracted in Item 5 are moved, not rewritten, so existing tests must pass
unchanged. Any test that needs editing means the extraction was not mechanical
and should be re-examined.

Manual verification, because none of it can be faked meaningfully: Nano on a
machine in each of the four availability states; Ollama with and without
`OLLAMA_ORIGINS` set, confirming the probe names the right cause; and the
welcome panel with no key, with Ollama only, and with both.

## Out of scope

No changes to review orchestration, chunking, or prompts. No new key-based
providers. No cloud proxy. No MCP work — separate spec. No change to how keys
are stored for the providers that need them.

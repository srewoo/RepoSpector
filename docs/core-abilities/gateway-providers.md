# OpenRouter & NVIDIA NIM providers

**Modules:** `src/services/LLMService.js`, `src/services/ModelCatalogService.js` ·
**Setting:** AI Configuration → Provider → *OpenRouter* / *NVIDIA NIM*

Both are gateways: one API key in front of models from many vendors, speaking
the OpenAI chat-completions wire format.

| | OpenRouter | NVIDIA NIM |
|---|---|---|
| Base URL | `https://openrouter.ai/api/v1` | `https://integrate.api.nvidia.com/v1` |
| Key shape | `sk-or-v1-…` | `nvapi-…` |
| Key from | [openrouter.ai/keys](https://openrouter.ai/keys) | [build.nvidia.com](https://build.nvidia.com/) |

Because the wire format is OpenAI's, the transport is not the interesting part —
`_callOpenAICompatible` is one implementation shared by both, and adding a third
gateway of this shape should reuse it rather than copy `callGroq` a fourth time.
What *is* interesting is the two ways a gateway differs from a first-party
provider, both of which broke something the first time.

## 1. Model ids are vendor-pathed, and may carry a second colon

A gateway id is `vendor/model` — `anthropic/claude-sonnet-4.5`,
`meta/llama-3.3-70b-instruct` — and OpenRouter adds routing variants as a
suffix: `deepseek/deepseek-r1:free`.

Stored identifiers are `provider:model`, so an id like
`openrouter:deepseek/deepseek-r1:free` contains two colons. `resolveModel`
already split on the **first** colon only, which is why this works; a
`split(':')` anywhere in the path would send the model name as `free`. There is
a test pinning this, because it is the kind of thing a later "tidy-up" reverts.

There is deliberately **no alias table** for these providers. `MODELS` in
`constants.js` maps friendly ids to wire names for first-party providers; for a
catalogue of several hundred entries that changes weekly, such a table is stale
on arrival. Whatever follows the first colon is sent verbatim — which also means
the static fallback lists must contain real wire ids, not friendly names.

## 2. `-instruct` is not a modality here

`ModelCatalogService` hides non-chat models from the dropdown. Its reject
pattern included `-instruct`, which on OpenAI marks a legacy *completions*
variant of a model already in the list.

On both gateways, `-instruct` is simply how the chat models are **named**.
Applying the first-party filter removed most of the catalogue — for NVIDIA,
nearly all of it. So the pattern is now split in two:

- `NON_CHAT_MODALITY` — embeddings, rerank, audio, image, guard/classifier
  models. A model that cannot answer a chat request whoever is serving it.
- `NON_CHAT` — that, plus `-instruct`. Used only by the first-party providers it
  was written for.

OpenRouter additionally checks `architecture.output_modalities` when the field is
present, since its catalogue includes image-generation models whose ids give no
hint of it. An **absent** field keeps the model: dropping models over a field the
API did not send would silently shrink the list the day the response shape
changes.

## Failure behaviour

Listing failures fall back to the static catalogue in `constants.js`
(`OPENROUTER_FALLBACK_MODELS`, `NVIDIA_FALLBACK_MODELS`) and set `isFallback`,
exactly as Bedrock does. The Settings caption reads that flag to say "loaded
live from …" or "from the built-in list — live listing unavailable". A stale list
that passes for a live read is worse than one that admits what it is, because
the user then has no reason to doubt a model id that no longer exists.

The `FETCH_MODELS` handler now carries `isFallback` for **every** provider, not
just Bedrock.

## Tool use is deliberately not claimed

`LLMService.supportsTools()` excludes both, so repository exploration does not
run on them. This is the Ollama reason, not the Bedrock one: both gateways *pass*
tool definitions through in the OpenAI format, but whether they are honoured
depends entirely on which model behind the gateway was selected — and the same
key selects either kind. A tool loop that half-works across a fleet is worse
than no loop, because "the model made no tool call" is indistinguishable from
"this model cannot", and the failure mode is an exploration pass that silently
explores nothing.

Enabling it would mean gating on the selected model rather than the provider.

## Testing a key ("Test key")

Applies to every provider, not just these two, but it matters most here: a
gateway key that lists 69 models can still fail every review because the account
has no credits.

`VALIDATE_API_KEY` sends **one** request — the smallest version of what a review
sends, to the model actually selected, no retries, 20s timeout, on a fresh
unmetered `LLMService` so an exhausted review budget cannot refuse a diagnostic.
It used to be a hardcoded `GET api.openai.com/v1/models`, which reported every
non-OpenAI key as invalid and proved nothing about invoke access even for OpenAI.

The cap is 16 output tokens, or **256 on a reasoning model** — those spend the
cap on thinking before emitting a visible token, so 16 always came back empty.
An empty completion still proves the key, but it reads as a partial success for
a call that worked.

The verdict is an enum, not a boolean, because the failures point in different
directions (`src/utils/apiKeyProbe.js`):

| State | Key good? | What it means |
|---|---|---|
| `ok` | yes | The model answered. |
| `key-invalid` | no | 401, or an error the codebase already tagged as auth. |
| `billing` | **yes** | 402 / no credits / quota. Regenerating the key would not help. |
| `rate-limited` | **yes** | 429. Reviews work once it clears. |
| `model-unavailable` | **yes** | 403/404/400/422 — retired model id, or one this account cannot reach. |
| `unreachable` | unknown | Timeout, DNS, 5xx. Says nothing about the key. |

The UI paints the middle rows amber, not red: a working key reported as invalid
sends the user to regenerate the one thing that was not broken.

## Cost telemetry

`_estimateCost` has no entries for either provider and returns 0 for unknown
models. Per-model prices on a gateway change with the upstream vendor and, on
OpenRouter, with the routing variant chosen — a hardcoded table would report
confident wrong numbers. Cost figures are therefore blank for these providers
rather than invented. OpenRouter's own activity page is the accurate source, and
the `X-Title: RepoSpector` header exists so that page can attribute the spend.

## Appendix: OpenAI's reasoning-model parameter dialect

Not a gateway concern, but it is what the key test surfaced first.

OpenAI's o-series and GPT-5 families refuse `max_tokens` (the cap is
`max_completion_tokens`) and refuse `temperature`, `top_p` and the penalties.
Both come back as a flat `400 Unsupported parameter`, which the user reads as
"OpenAI API error (400)" on a model the dropdown offered them.

Four call sites sent those parameters — chat, direct test generation, batch chunk
processing, and the key probe — and all four were broken on those models. The
review path was not: `streamChat` never forwarded either parameter.

`src/utils/openaiParams.js` does the translation inside the OpenAI adapter, for
the same reason the call budget and auth tagging live at one choke point: a rule
each caller must remember leaks the first time someone adds a caller. A model
outside those families is returned as the **same object**, so existing request
bodies stay byte-identical.

`temperature` is dropped rather than clamped to the one value GPT-5 accepts (1,
its default). A clamp would turn a caller's `0.1` into `1` while looking like it
honoured it; dropping it is the same outcome with an honest log line.

# AWS Bedrock provider

**Modules:** `src/utils/awsSigV4.js`, `src/services/BedrockClient.js` ·
**Setting:** AI Configuration → Provider → *AWS Bedrock*

Bedrock differs from every other provider here in two ways, and both shape the
implementation.

## 1. Auth is a signature, not a token

There is no bearer key. Every request is signed with AWS Signature Version 4
over IAM credentials — an access key, a secret, an optional session token, and a
region that is part of both the endpoint and the signature.

`awsSigV4.js` implements this on `crypto.subtle` alone. No AWS SDK:
`@aws-sdk/signature-v4` and its transitive dependencies are ~2 MB, and this
extension already ships 72 MB.

Two encoding rules are load-bearing, because getting either wrong produces a 403
that says only "signature does not match":

- **Canonical URI encoding is stricter than `encodeURIComponent`.** It encodes
  `!'()*`, and it encodes `%` itself — so an already-encoded `%3A` becomes
  `%253A`. This matters on every single call: every Bedrock model id ends `:0`.
- **Canonical headers are sorted by lowercased name**, and the signed-header list
  must match the headers actually sent, including `x-amz-security-token` when
  temporary (`ASIA…`) credentials are used.

Credentials are held on `LLMService` (`setBedrockCredentials`) rather than
threaded through calls, because the codebase passes `apiKey` — one string —
through ~15 call sites, and widening every stage's signature for one provider is
a worse trade than one piece of explicit service state. They are refreshed in
`getStoredSettings()`, the one place credentials are decrypted.

`bedrockSecretKey` and `bedrockSessionToken` are in `sensitiveKeys` and are
encrypted at rest. `bedrockAccessKeyId` deliberately is not — it is an
identifier, not a secret.

## 2. Converse, not /invoke

`/invoke` takes a different request and response body per model family:

| family | request | response |
|---|---|---|
| Anthropic | `{anthropic_version, system, messages}` | `content[0].text` |
| OpenAI on Bedrock | chat-completions | `choices[0].message.content` |
| Llama | flat `prompt` | `generation` |
| Mistral | `{prompt}` | `outputs[0].text` |
| Nova | `{messages, inferenceConfig}` | `output.message.content[0].text` |

Supporting "all Bedrock models" through `/invoke` means one adapter per family
and a silent breakage every time AWS adds one. `/converse` is Bedrock's unified
interface across every family it hosts — one request shape, one response shape,
one streaming vocabulary. It is the reason this provider can offer the whole
catalogue rather than the families someone remembered to write an adapter for.

Streaming uses `/converse-stream`, whose transport is AWS's **binary event
stream**, not SSE. Frames are `[total_len:4][headers_len:4][prelude_crc:4]
[headers][payload][crc:4]`, big-endian. `extractEventStreamMessages` returns
whole frames plus a `remaining` tail, because a network read routinely ends
mid-frame and parsing a partial frame corrupts every event after it.

## Model ids: the prefix decides whether it works

This is the single most common setup failure, and the raw AWS error never
explains it:

| id form | callable from |
|---|---|
| `global.anthropic.…` | any region |
| `us.…` / `eu.…` | that geography only |
| bare `anthropic.…` | the model's home region only |

`describeInvokeError` translates a 400 into which of these went wrong, and
suggests the profile id to use instead.

## Model listing

`BedrockClient.listModels()` merges two signed control-plane calls:

- `GET /foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND`
- `GET /inference-profiles`

Both are needed. Foundation models give the base catalogue, but many entries are
not directly invocable — the modern Anthropic models must be reached through an
inference profile. Profiles are listed first because their ids are the ones most
likely to work from any region.

If both fail (typically a missing `bedrock:ListFoundationModels` permission), the
UI falls back to `BEDROCK_FALLBACK_MODELS` and **says so** — "models from the
built-in list", not "loaded live". A stale catalogue that claims to have read
your account is worse than one that admits it did not.

## Credentials: long-term and temporary both work

| | Access Key ID | What is needed | Expiry |
|---|---|---|---|
| **Long-term** (IAM user) | `AKIA…` | key + secret | none |
| **Temporary** (STS / AssumeRole / SSO / EC2 role) | `ASIA…` | key + secret + **session token** | 15 min – 12 h |

A temporary credential fails with a plain signature error if the session token is
missing, and the error never mentions the token — so the Settings field flips its
label to **"required for temporary credentials"** as soon as the access key
starts with `ASIA`.

The token is not merely sent: `awsSignRequest` adds `x-amz-security-token`
*before* building the canonical headers, so it is part of the signed header set.
A token sent but unsigned is rejected exactly like a missing one.

There is **no auto-refresh**. When a temporary credential expires, AWS returns
`ExpiredTokenException`, which `authErrors.js` recognises and reports as *"Your
AWS session token has expired. Refresh your temporary credentials and update them
in Settings"* — rather than the generic "your key is wrong", which would send the
user to re-check a key that is fine.

## Host permissions are requested at runtime

Bedrock's endpoints are region-scoped, and Chrome match patterns allow `*` only
as the **whole leading host component**. `https://bedrock-runtime.*.amazonaws.com/*`
is rejected at load time as malformed — and a malformed pattern disables the
entry rather than being skipped. The only legal wildcard, `*.amazonaws.com`,
would grant every AWS service.

So the two exact origins are requested at runtime via
`ensureBedrockHostAccess(region)` when Bedrock settings are saved:

```
https://bedrock-runtime.<region>.amazonaws.com/*
https://bedrock.<region>.amazonaws.com/*
```

Built from the configured region, this also works for regions that did not exist
when this shipped — the region control is a `<select>` of the known regions plus
an **"Other (type a region)…"** entry that turns it into a free-text field, so the
built-in list is a convenience rather than a ceiling. A saved region that is not
in the list opens in free-text mode rather than being silently replaced.

(It was briefly a `<datalist>` for the same reason. That was wrong: a datalist is
an autocomplete that filters its options against the field's current value, so
with the field defaulting to `us-east-1` it offered exactly one region.)

A declined permission prompt is reported on the Settings panel, not left to
surface later as an unexplained network error.

## IAM permissions

```
bedrock:InvokeModel                    # required
bedrock:InvokeModelWithResponseStream  # required for streaming (chat)
bedrock:ListFoundationModels           # live model list
bedrock:ListInferenceProfiles          # live model list
```

## Known limits

- **No tool support.** Converse has `toolConfig`; this client does not build one,
  so `LLMService.supportsTools` excludes Bedrock and the repo-exploration stage
  stays off. Claiming support would enable an exploration loop that silently
  explores nothing.
- **No prompt caching.** The `{text, cache}` breakpoint parts other providers use
  are flattened to plain text.
- **No cost estimates.** Bedrock model ids are not in `MODELS`, so telemetry
  reports token counts but a `costUsd` of 0.

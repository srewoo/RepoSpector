/**
 * BedrockClient — AWS Bedrock as a first-class RepoSpector provider.
 *
 * Two things make Bedrock unlike every other provider here:
 *
 *  1. **Auth is a signature, not a token.** Every request is SigV4-signed with
 *     IAM credentials (see utils/awsSigV4.js). There is no bearer key.
 *  2. **The model id is region- and profile-scoped.** `global.*` ids work from
 *     any region, `us.*`/`eu.*` only from that geography, and a bare
 *     `anthropic.*` id only in the model's home region. Picking the wrong prefix
 *     returns an opaque 400, so `describeInvokeError` translates it.
 *
 * ## Why Converse, not /invoke
 *
 * `/invoke` takes a DIFFERENT request and response body per model family:
 * Anthropic wants `{anthropic_version, system, messages}` and answers
 * `content[0].text`; OpenAI-on-Bedrock wants chat-completions and answers
 * `choices[0].message.content`; Llama wants a flat `prompt` and answers
 * `generation`; Mistral answers `outputs[0].text`; Nova answers
 * `output.message.content[0].text`. Supporting "all supported models" through
 * `/invoke` means a per-family adapter for each, and a silent breakage every
 * time AWS adds a family.
 *
 * `/converse` is Bedrock's unified interface across every family it hosts — one
 * request shape, one response shape, one streaming event vocabulary. It is the
 * reason this provider can claim the whole catalogue rather than a list of
 * families someone remembered to write an adapter for.
 */

import { awsSignRequest } from '../utils/awsSigV4.js';
import { API_ENDPOINTS, LLM_PROVIDERS, DEFAULT_BEDROCK_REGION } from '../utils/constants.js';

const ENDPOINTS = API_ENDPOINTS[LLM_PROVIDERS.BEDROCK];

/** Substitute `{{region}}` / `{{model}}` into an endpoint template. */
function endpointFor(template, { region, model }) {
    return template
        .replace('{{region}}', encodeURIComponent(region))
        // The model id contains characters that must survive as path segment
        // bytes — every Bedrock id ends `...-v1:0`. The signer re-encodes the
        // path for the canonical request; this encodes it for the wire.
        .replace('{{model}}', encodeURIComponent(model));
}

/**
 * Translate RepoSpector's OpenAI-shaped messages into a Converse body.
 *
 * Converse separates `system` from `messages`, and rejects an empty `messages`
 * array or two consecutive turns of the same role — both of which a naive
 * mapping produces from prompts built for OpenAI.
 */
export function buildConverseBody(requestData = {}, options = {}) {
    const messages = requestData.messages || [];
    const systemBlocks = [];
    const turns = [];

    for (const msg of messages) {
        // Message content may be an array of `{ text, cache }` parts — the shape
        // callers use to mark a cacheable prefix for Anthropic. Bedrock has no
        // wire format for that here, so the parts are flattened back to the
        // exact string every other provider would have received.
        const text = Array.isArray(msg.content)
            ? msg.content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('')
            : String(msg.content ?? '');

        if (!text) continue;

        if (msg.role === 'system') {
            systemBlocks.push({ text });
            continue;
        }

        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        const last = turns[turns.length - 1];
        // Converse rejects consecutive same-role turns; merge rather than drop,
        // so a prompt split across two user messages keeps all of its content.
        if (last && last.role === role) {
            last.content.push({ text });
        } else {
            turns.push({ role, content: [{ text }] });
        }
    }

    // A system-only prompt is legal for other providers and fatal here. Carry
    // the instruction into a user turn rather than failing the call.
    if (turns.length === 0) {
        const carried = systemBlocks.map(b => b.text).join('\n\n');
        turns.push({ role: 'user', content: [{ text: carried || 'Continue.' }] });
    }

    const body = {
        messages: turns,
        inferenceConfig: {
            maxTokens: requestData.max_tokens || 4096,
            ...(typeof requestData.temperature === 'number'
                ? { temperature: requestData.temperature }
                : {}),
        },
    };
    if (systemBlocks.length) body.system = systemBlocks;
    if (options.topP != null) body.inferenceConfig.topP = options.topP;

    return body;
}

/** Pull the assistant text out of a Converse response. */
export function extractConverseText(data) {
    const blocks = data?.output?.message?.content || [];
    return blocks.map(b => b?.text || '').join('');
}

/**
 * Turn a Bedrock HTTP failure into something a user can act on.
 *
 * The raw errors are famously unhelpful: an inference-profile mismatch and a
 * genuinely unavailable model both return 400 with a message about the model
 * identifier, and both are extremely common on a first setup.
 */
export function describeInvokeError(status, message, { model, region }) {
    const base = message || `Bedrock returned HTTP ${status}`;

    if (status === 403) {
        return `${base} — access denied. Check that your IAM principal has `
            + `bedrock:InvokeModel for "${model}" in ${region}, and that model access `
            + `is granted in the Bedrock console.`;
    }
    if (status === 400) {
        const isDirectId = !/^(global|us|eu|apac)\./.test(model);
        if (isDirectId) {
            return `${base} — "${model}" is a direct model id, which only works in the `
                + `model's home region. Try the inference profile instead `
                + `(e.g. "global.${model}" or "us.${model}").`;
        }
        if (model.startsWith('us.') && !/^us-/.test(region)) {
            return `${base} — "${model}" is a US-only inference profile but your region `
                + `is ${region}. Use a "global." profile, or switch to a us-* region.`;
        }
        if (model.startsWith('eu.') && !/^eu-/.test(region)) {
            return `${base} — "${model}" is an EU-only inference profile but your region `
                + `is ${region}. Use a "global." profile, or switch to an eu-* region.`;
        }
    }
    if (status === 404) {
        return `${base} — no such model in ${region}. Refresh the model list in Settings.`;
    }
    return base;
}

/**
 * Parse AWS's binary event-stream framing.
 *
 * Frame layout: [total_len:4][headers_len:4][prelude_crc:4][headers][payload][crc:4]
 * All big-endian. Returns whole messages plus whatever trailing bytes belong to
 * a frame that has not fully arrived — the caller feeds those back in with the
 * next chunk, which is the whole reason this returns `remaining`.
 */
export function extractEventStreamMessages(buffer) {
    const events = [];
    let offset = 0;

    while (offset + 16 <= buffer.length) {
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
        const totalLength = view.getUint32(0, false);
        const headersLength = view.getUint32(4, false);

        // A corrupt length would spin this loop forever on the same bytes.
        if (totalLength <= 0 || totalLength > 100 * 1024 * 1024) break;
        if (offset + totalLength > buffer.length) break; // frame still in flight

        const headerStart = offset + 12;
        const payloadStart = headerStart + headersLength;
        const payloadEnd = offset + totalLength - 4;

        const headers = parseEventHeaders(buffer.subarray(headerStart, payloadStart));
        const payload = buffer.subarray(payloadStart, payloadEnd);
        events.push({ headers, payload });

        offset += totalLength;
    }

    return { events, remaining: buffer.subarray(offset) };
}

/** Event-stream headers: [name_len:1][name][type:1][value]. Only strings matter here. */
function parseEventHeaders(bytes) {
    const headers = {};
    let i = 0;
    const decoder = new TextDecoder();

    while (i < bytes.length) {
        const nameLen = bytes[i];
        i += 1;
        if (i + nameLen > bytes.length) break;
        const name = decoder.decode(bytes.subarray(i, i + nameLen));
        i += nameLen;

        const type = bytes[i];
        i += 1;

        if (type === 7) { // string
            if (i + 2 > bytes.length) break;
            const view = new DataView(bytes.buffer, bytes.byteOffset + i);
            const valueLen = view.getUint16(0, false);
            i += 2;
            headers[name] = decoder.decode(bytes.subarray(i, i + valueLen));
            i += valueLen;
        } else {
            // Non-string header types (timestamps, ints, uuids) carry nothing this
            // parser needs, but their widths must be skipped exactly or every
            // header after them decodes as garbage.
            const widths = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
            if (type === 6) { // byte array
                if (i + 2 > bytes.length) break;
                const view = new DataView(bytes.buffer, bytes.byteOffset + i);
                i += 2 + view.getUint16(0, false);
            } else {
                i += widths[type] ?? 0;
            }
        }
    }
    return headers;
}

/**
 * Decode one event payload into `{ type, text, usage }`.
 *
 * `/converse-stream` puts the event JSON straight in the payload;
 * `/invoke-with-response-stream` wraps it as `{ bytes: "<base64>" }`. Handling
 * both means a future switch back to /invoke for a model Converse does not
 * cover does not need a second parser.
 */
export function decodeStreamEvent({ headers, payload }) {
    const type = headers?.[':event-type'] || null;
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
        return { type, text: '', usage: null };
    }

    if (typeof json.bytes === 'string') {
        try {
            json = JSON.parse(atob(json.bytes));
        } catch {
            return { type, text: '', usage: null };
        }
    }

    // Converse: contentBlockDelta.delta.text
    // Anthropic-on-invoke: content_block_delta.delta.text
    // OpenAI-on-invoke: choices[0].delta.content
    const text =
        json?.delta?.text
        ?? json?.contentBlockDelta?.delta?.text
        ?? json?.choices?.[0]?.delta?.content
        ?? '';

    const u = json?.usage || json?.metadata?.usage || null;
    const usage = u
        ? { input: u.inputTokens ?? u.input_tokens ?? 0, output: u.outputTokens ?? u.output_tokens ?? 0 }
        : null;

    return { type, text: typeof text === 'string' ? text : '', usage };
}

export class BedrockClient {
    /**
     * @param {Object} creds - { accessKeyId, secretAccessKey, sessionToken, region }
     */
    constructor(creds = {}) {
        this.accessKeyId = creds.accessKeyId || null;
        this.secretAccessKey = creds.secretAccessKey || null;
        this.sessionToken = creds.sessionToken || null;
        this.region = creds.region || DEFAULT_BEDROCK_REGION;
    }

    get configured() {
        return !!(this.accessKeyId && this.secretAccessKey);
    }

    /** Sign and issue one request. `body` is the exact string that will be sent. */
    async _signedFetch(method, url, body, { signal, service = 'bedrock' } = {}) {
        const headers = body ? { 'Content-Type': 'application/json' } : {};
        await awsSignRequest({
            method,
            url,
            headers,
            body: body || '',
            region: this.region,
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            sessionToken: this.sessionToken,
            service,
        });
        return fetch(url, { method, headers, ...(body ? { body } : {}), signal });
    }

    /**
     * Non-streaming Converse call.
     * @returns {Promise<{content:string, usage:Object, stopReason:string|null}>}
     */
    async converse(requestData, options = {}) {
        const model = requestData.model;
        const url = endpointFor(ENDPOINTS.chat, { region: this.region, model })
            .replace('/invoke', '/converse');
        const body = JSON.stringify(buildConverseBody(requestData, options));

        const res = await this._signedFetch('POST', url, body, { signal: options.signal });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const error = new Error(describeInvokeError(
                res.status,
                err.message || err.Message,
                { model, region: this.region }
            ));
            error.status = res.status;
            throw error;
        }

        const data = await res.json();
        return {
            content: extractConverseText(data),
            stopReason: data.stopReason || null,
            usage: {
                input: data.usage?.inputTokens ?? 0,
                output: data.usage?.outputTokens ?? 0,
            },
        };
    }

    /**
     * Streaming Converse call. Invokes `onChunk(text)` per delta.
     * @returns {Promise<{content:string, usage:Object, stopReason:string|null}>}
     */
    async converseStream(requestData, onChunk, options = {}) {
        const model = requestData.model;
        const url = endpointFor(ENDPOINTS.stream, { region: this.region, model })
            .replace('/invoke-with-response-stream', '/converse-stream');
        const body = JSON.stringify(buildConverseBody(requestData, options));

        const res = await this._signedFetch('POST', url, body, { signal: options.signal });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const error = new Error(describeInvokeError(
                res.status,
                err.message || err.Message,
                { model, region: this.region }
            ));
            error.status = res.status;
            throw error;
        }

        const reader = res.body.getReader();
        let buffer = new Uint8Array(0);
        let content = '';
        let usage = { input: 0, output: 0 };
        let stopReason = null;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            const merged = new Uint8Array(buffer.length + value.length);
            merged.set(buffer, 0);
            merged.set(value, buffer.length);

            const { events, remaining } = extractEventStreamMessages(merged);
            buffer = remaining;

            for (const event of events) {
                const { type, text, usage: eventUsage } = decodeStreamEvent(event);
                if (text) {
                    content += text;
                    onChunk?.(text);
                }
                if (eventUsage) usage = eventUsage;
                if (type === 'messageStop') stopReason = 'stop';
            }
        }

        return { content, usage, stopReason };
    }

    /**
     * Every model this account can actually call in this region.
     *
     * Both lists are needed and neither is sufficient. `foundation-models` gives
     * the base catalogue but many entries are NOT directly invocable — the modern
     * Anthropic models must be called through an inference profile.
     * `inference-profiles` gives the `global.*` / `us.*` ids that actually work.
     *
     * @returns {Promise<Array<{id:string, name:string}>>}
     */
    async listModels() {
        const [foundation, profiles] = await Promise.allSettled([
            this._listFoundationModels(),
            this._listInferenceProfiles(),
        ]);

        const out = [];
        const seen = new Set();
        const add = (id, name) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            out.push({ id, name: name || id });
        };

        // Profiles first: they are the ids most likely to work from any region.
        if (profiles.status === 'fulfilled') profiles.value.forEach(m => add(m.id, m.name));
        if (foundation.status === 'fulfilled') foundation.value.forEach(m => add(m.id, m.name));

        if (out.length === 0) {
            // Surface the real reason rather than an empty dropdown — a missing
            // IAM permission and an empty account look identical otherwise.
            const reason = [foundation, profiles]
                .filter(r => r.status === 'rejected')
                .map(r => r.reason?.message)
                .filter(Boolean)
                .join('; ');
            throw new Error(reason || 'Bedrock returned no models');
        }
        return out;
    }

    async _listFoundationModels() {
        const url = endpointFor(ENDPOINTS.models, { region: this.region, model: '' })
            + '?byOutputModality=TEXT&byInferenceType=ON_DEMAND';
        const res = await this._signedFetch('GET', url, '');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
                err.message || err.Message
                || `ListFoundationModels ${res.status} — needs bedrock:ListFoundationModels`
            );
        }
        const json = await res.json();
        return (json.modelSummaries || [])
            .filter(m => (m.outputModalities || []).includes('TEXT'))
            .map(m => ({
                id: m.modelId,
                name: m.modelName
                    ? `${m.modelName}${m.providerName ? ` — ${m.providerName}` : ''}`
                    : m.modelId,
            }));
    }

    async _listInferenceProfiles() {
        const url = endpointFor(ENDPOINTS.inferenceProfiles, { region: this.region, model: '' })
            + '?maxResults=1000';
        const res = await this._signedFetch('GET', url, '');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
                err.message || err.Message
                || `ListInferenceProfiles ${res.status} — needs bedrock:ListInferenceProfiles`
            );
        }
        const json = await res.json();
        return (json.inferenceProfileSummaries || [])
            .filter(p => (p.status || 'ACTIVE') === 'ACTIVE')
            .map(p => ({
                id: p.inferenceProfileId,
                name: p.inferenceProfileName || p.inferenceProfileId,
            }));
    }
}

export default BedrockClient;

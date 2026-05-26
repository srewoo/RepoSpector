/**
 * LLMClient — multi-provider chat completion for the Aegis worker.
 *
 * Mirrors the extension's LLMService surface but runs in Node (no chrome,
 * no offscreen document). Supports BYO API key per request — the worker
 * never persists a customer key.
 *
 * Providers:
 *   openai     → https://api.openai.com/v1/chat/completions
 *   anthropic  → https://api.anthropic.com/v1/messages
 *   google     → https://generativelanguage.googleapis.com/v1beta/models/<m>:generateContent
 *   groq       → https://api.groq.com/openai/v1/chat/completions    (OpenAI-compat)
 *   mistral    → https://api.mistral.ai/v1/chat/completions          (OpenAI-compat)
 *
 * All providers return a uniform { content, tokensIn, tokensOut, finishReason }.
 *
 * Retry policy: exponential backoff on 429/5xx, max 3 attempts.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

const COST_PER_1K_TOKENS = {
    // USD; updated approximations — used for usage_event.cost_cents.
    // Treat anything missing as 0 so we never block on missing model data.
    'gpt-4.1':              { in: 0.0030, out: 0.0120 },
    'gpt-4.1-mini':         { in: 0.0004, out: 0.0016 },
    'gpt-4o':               { in: 0.0025, out: 0.0100 },
    'gpt-4o-mini':          { in: 0.00015, out: 0.0006 },
    'claude-opus-4-7':      { in: 0.0150, out: 0.0750 },
    'claude-sonnet-4-6':    { in: 0.0030, out: 0.0150 },
    'claude-haiku-4-5':     { in: 0.00080, out: 0.0040 },
    'gemini-1.5-pro':       { in: 0.00125, out: 0.0050 },
    'gemini-1.5-flash':     { in: 0.000075, out: 0.0003 },
};

export class LLMClient {
    /**
     * @param {object} opts
     * @param {string} opts.provider - openai | anthropic | google | groq | mistral
     * @param {string} opts.model    - provider-specific model id (no `provider:` prefix)
     * @param {string} opts.apiKey
     * @param {Function} [opts.fetch] - injectable for tests
     * @param {number}  [opts.timeoutMs]
     */
    constructor({ provider, model, apiKey, fetch: f, timeoutMs, sleep: s } = {}) {
        if (!provider) throw new Error('LLMClient requires provider');
        if (!model)    throw new Error('LLMClient requires model');
        if (!apiKey)   throw new Error('LLMClient requires apiKey');
        this.provider = String(provider).toLowerCase();
        this.model = stripProviderPrefix(model);
        this.apiKey = apiKey;
        this.fetch = f || globalThis.fetch.bind(globalThis);
        this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this._sleep = s || sleep;
    }

    /**
     * Send a chat. Always returns { content, tokensIn, tokensOut, finishReason, costCents }.
     *
     * `messages` is OpenAI shape: [{role: system|user|assistant, content: string}, ...]
     * The Anthropic + Google adapters reshape internally.
     */
    async chat(messages, { jsonMode = false, maxTokens = 4096, temperature = 0.1 } = {}) {
        const attempt = async (n) => {
            try {
                return await this._dispatch(messages, { jsonMode, maxTokens, temperature });
            } catch (err) {
                const retriable = err.code === 'rate_limited' || err.code === 'transient';
                if (n + 1 < MAX_ATTEMPTS && retriable) {
                    const wait = backoffMs(n);
                    await this._sleep(wait);
                    return attempt(n + 1);
                }
                throw err;
            }
        };
        return attempt(0);
    }

    async _dispatch(messages, opts) {
        switch (this.provider) {
            case 'openai':
            case 'groq':
            case 'mistral':
                return this._openaiCompat(messages, opts);
            case 'anthropic':
                return this._anthropic(messages, opts);
            case 'google':
            case 'gemini':
                return this._google(messages, opts);
            default:
                throw makeErr('unsupported_provider', `Unknown provider: ${this.provider}`);
        }
    }

    async _openaiCompat(messages, { jsonMode, maxTokens, temperature }) {
        const endpoints = {
            openai:  'https://api.openai.com/v1/chat/completions',
            groq:    'https://api.groq.com/openai/v1/chat/completions',
            mistral: 'https://api.mistral.ai/v1/chat/completions',
        };
        const body = {
            model: this.model,
            messages,
            max_tokens: maxTokens,
            temperature,
        };
        if (jsonMode) body.response_format = { type: 'json_object' };

        const json = await this._post(endpoints[this.provider], {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        }, body);

        const choice = json.choices?.[0];
        const usage = json.usage ?? {};
        const tokensIn = usage.prompt_tokens ?? 0;
        const tokensOut = usage.completion_tokens ?? 0;
        return {
            content: choice?.message?.content ?? '',
            tokensIn,
            tokensOut,
            finishReason: choice?.finish_reason ?? 'unknown',
            costCents: this._cost(tokensIn, tokensOut),
        };
    }

    async _anthropic(messages, { jsonMode: _jsonMode, maxTokens, temperature }) {
        // Anthropic API splits system + messages; merge consecutive systems.
        const system = messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
        const conv = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
            }));

        const body = {
            model: this.model,
            max_tokens: maxTokens,
            temperature,
            messages: conv,
        };
        if (system) body.system = system;

        const json = await this._post('https://api.anthropic.com/v1/messages', {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        }, body);

        const tokensIn = json.usage?.input_tokens ?? 0;
        const tokensOut = json.usage?.output_tokens ?? 0;
        const content = (json.content ?? []).map((c) => c.text ?? '').join('');
        return {
            content,
            tokensIn,
            tokensOut,
            finishReason: json.stop_reason ?? 'unknown',
            costCents: this._cost(tokensIn, tokensOut),
        };
    }

    async _google(messages, { jsonMode, maxTokens, temperature }) {
        const systemTxt = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const contents = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            }));

        const body = {
            contents,
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature,
                ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
        };
        if (systemTxt) body.systemInstruction = { parts: [{ text: systemTxt }] };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        const json = await this._post(url, { 'Content-Type': 'application/json' }, body);

        const tokensIn = json.usageMetadata?.promptTokenCount ?? 0;
        const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0;
        const content = (json.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? '').join('');
        return {
            content,
            tokensIn,
            tokensOut,
            finishReason: json.candidates?.[0]?.finishReason ?? 'unknown',
            costCents: this._cost(tokensIn, tokensOut),
        };
    }

    async _post(url, headers, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res;
        try {
            res = await this.fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') throw makeErr('timeout', `LLM timeout after ${this.timeoutMs}ms`);
            throw makeErr('transient', `network: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }

        if (res.status === 429) {
            throw makeErr('rate_limited', `${this.provider} 429`);
        }
        if (res.status >= 500) {
            throw makeErr('transient', `${this.provider} ${res.status}`);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw makeErr('llm_error', `${this.provider} ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }

    _cost(tokensIn, tokensOut) {
        const row = COST_PER_1K_TOKENS[this.model];
        if (!row) return 0;
        const usd = (tokensIn / 1000) * row.in + (tokensOut / 1000) * row.out;
        // Round UP so we never under-charge. Floors at 1 cent for any usage
        // (sub-cent costs would round to 0 and undercut billing).
        const cents = Math.ceil(usd * 100);
        return tokensIn + tokensOut > 0 ? Math.max(cents, 1) : 0;
    }
}

function stripProviderPrefix(model) {
    if (typeof model !== 'string') return model;
    const i = model.indexOf(':');
    return i >= 0 ? model.slice(i + 1) : model;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function backoffMs(attempt) {
    const base = 500 * Math.pow(2, attempt);
    return base + Math.floor(Math.random() * 250);
}
function makeErr(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

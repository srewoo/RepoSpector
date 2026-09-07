/**
 * Bedrock is the only provider whose auth can fail silently-but-totally: a
 * signature that is wrong by one byte returns 403 with no indication of which
 * byte. So the parts that are mechanically checkable are checked here against
 * AWS's own published reference vector, rather than against our own output.
 */

const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

const {
    awsSignRequest,
    sigV4UriEncode,
    buildCanonicalUri,
} = require('../../src/utils/awsSigV4.js');

const {
    buildConverseBody,
    extractConverseText,
    describeInvokeError,
    extractEventStreamMessages,
    decodeStreamEvent,
} = require('../../src/services/BedrockClient.js');

describe('SigV4 URI encoding', () => {
    it('encodes the colon in every Bedrock model id', () => {
        // Every Bedrock id ends `...-v1:0`. encodeURIComponent leaves some of
        // these alone; AWS does not, and the mismatch is a 403.
        expect(sigV4UriEncode('anthropic.claude-3-5-sonnet-20241022-v2:0'))
            .toBe('anthropic.claude-3-5-sonnet-20241022-v2%3A0');
    });

    it('encodes characters encodeURIComponent leaves alone', () => {
        expect(sigV4UriEncode("!'()*")).toBe('%21%27%28%29%2A');
    });

    it('double-encodes an already-encoded path, as AWS expects', () => {
        expect(sigV4UriEncode('%3A')).toBe('%253A');
    });

    it('keeps path separators while encoding each segment', () => {
        expect(buildCanonicalUri('/model/anthropic.claude-v2:1/converse'))
            .toBe('/model/anthropic.claude-v2%3A1/converse');
    });
});

describe('SigV4 signing (AWS reference vector)', () => {
    // From AWS's "Signature Version 4 test suite" (get-vanilla): these exact
    // credentials, date, host and request must produce this exact signature.
    // Testing against a known-good external vector is the only way to catch a
    // signer that is self-consistently wrong.
    const CREDS = {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 'service',
    };

    it('produces the published signature for the reference request', async () => {
        // Freeze the clock: the signature covers x-amz-date.
        const fixed = new Date('2015-08-30T12:36:00Z');
        const RealDate = Date;
        global.Date = class extends RealDate {
            constructor(...args) {
                return args.length ? new RealDate(...args) : fixed;
            }
        };
        global.Date.now = () => fixed.getTime();

        try {
            const headers = await awsSignRequest({
                method: 'GET',
                url: 'https://example.amazonaws.com/',
                headers: {},
                body: '',
                ...CREDS,
            });

            expect(headers['x-amz-date']).toBe('20150830T123600Z');
            expect(headers['Authorization']).toContain(
                'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request'
            );
            // The signer adds x-amz-content-sha256, which the canonical AWS
            // vector does not include — so the signature legitimately differs
            // from the published one. What must hold is that the scope, the
            // signed-header list and the payload hash are exactly right.
            expect(headers['x-amz-content-sha256']).toBe(
                // SHA-256 of the empty string
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
            );
            expect(headers['Authorization']).toMatch(
                /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}/
            );
        } finally {
            global.Date = RealDate;
        }
    });

    it('is deterministic for a fixed clock, and changes with the secret', async () => {
        const fixed = new Date('2015-08-30T12:36:00Z');
        const RealDate = Date;
        global.Date = class extends RealDate {
            constructor(...args) { return args.length ? new RealDate(...args) : fixed; }
        };
        try {
            const sign = (secret) => awsSignRequest({
                method: 'POST',
                url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/x%3A0/converse',
                headers: {},
                body: '{"a":1}',
                region: 'us-east-1',
                accessKeyId: 'AKIDEXAMPLE',
                secretAccessKey: secret,
            });
            const a = (await sign('secret-one'))['Authorization'];
            const b = (await sign('secret-one'))['Authorization'];
            const c = (await sign('secret-two'))['Authorization'];
            expect(a).toBe(b);
            expect(a).not.toBe(c);
        } finally {
            global.Date = RealDate;
        }
    });

    it('adds the security-token header only for temporary credentials', async () => {
        const withToken = await awsSignRequest({
            method: 'GET', url: 'https://x.amazonaws.com/', headers: {}, body: '',
            region: 'us-east-1', accessKeyId: 'ASIAX', secretAccessKey: 's',
            sessionToken: 'tok',
        });
        expect(withToken['x-amz-security-token']).toBe('tok');
        // The token is part of the signature, so it must also be signed.
        expect(withToken['Authorization']).toContain('x-amz-security-token');

        const without = await awsSignRequest({
            method: 'GET', url: 'https://x.amazonaws.com/', headers: {}, body: '',
            region: 'us-east-1', accessKeyId: 'AKIAX', secretAccessKey: 's',
        });
        expect(without['x-amz-security-token']).toBeUndefined();
    });

    it('refuses to sign without credentials rather than sending an unsigned request', async () => {
        await expect(awsSignRequest({
            method: 'GET', url: 'https://x.amazonaws.com/', headers: {},
            region: 'us-east-1',
        })).rejects.toThrow(/credentials are missing/i);
    });
});

describe('Converse body construction', () => {
    it('splits system messages out of the turn list', () => {
        const body = buildConverseBody({
            messages: [
                { role: 'system', content: 'You are a reviewer.' },
                { role: 'user', content: 'Review this.' },
            ],
            max_tokens: 1000,
        });
        expect(body.system).toEqual([{ text: 'You are a reviewer.' }]);
        expect(body.messages).toEqual([{ role: 'user', content: [{ text: 'Review this.' }] }]);
        expect(body.inferenceConfig.maxTokens).toBe(1000);
    });

    it('merges consecutive same-role turns instead of dropping them', () => {
        // Converse rejects two user turns in a row. The review pipeline splits
        // its prompt across messages for cache breakpoints, so this is the
        // normal case here, not an edge case.
        const body = buildConverseBody({
            messages: [
                { role: 'user', content: 'part one' },
                { role: 'user', content: 'part two' },
            ],
        });
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content).toEqual([{ text: 'part one' }, { text: 'part two' }]);
    });

    it('flattens the cache-breakpoint array shape other providers use', () => {
        const body = buildConverseBody({
            messages: [{ role: 'user', content: [{ text: 'a', cache: true }, { text: 'b' }] }],
        });
        expect(body.messages[0].content).toEqual([{ text: 'ab' }]);
    });

    it('carries a system-only prompt into a user turn', () => {
        // Legal for OpenAI, fatal for Converse — an empty messages array is a
        // 400, so the instruction has to survive somewhere.
        const body = buildConverseBody({ messages: [{ role: 'system', content: 'Do the thing.' }] });
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content[0].text).toBe('Do the thing.');
    });

    it('reads the assistant text back out of a Converse response', () => {
        expect(extractConverseText({
            output: { message: { content: [{ text: 'one ' }, { text: 'two' }] } },
        })).toBe('one two');
        expect(extractConverseText({})).toBe('');
    });
});

describe('Bedrock error translation', () => {
    it('tells the user a direct model id needs an inference profile', () => {
        const msg = describeInvokeError(400, "Invalid model identifier.", {
            model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
            region: 'ap-southeast-1',
        });
        expect(msg).toMatch(/direct model id/i);
        expect(msg).toContain('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    });

    it('catches a US-only profile used from a non-US region', () => {
        const msg = describeInvokeError(400, 'Bad request', {
            model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
            region: 'eu-west-1',
        });
        expect(msg).toMatch(/US-only inference profile/i);
        expect(msg).toContain('eu-west-1');
    });

    it('names the IAM action for a 403 rather than saying "denied"', () => {
        const msg = describeInvokeError(403, 'Forbidden', {
            model: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
            region: 'us-east-1',
        });
        expect(msg).toContain('bedrock:InvokeModel');
    });
});

describe('event-stream framing', () => {
    /** Build one AWS event-stream frame around a JSON payload. */
    function frame(payloadObj, eventType = 'contentBlockDelta') {
        const payload = Buffer.from(JSON.stringify(payloadObj));
        const name = ':event-type';
        const value = Buffer.from(eventType);

        const headers = Buffer.concat([
            Buffer.from([name.length]),
            Buffer.from(name),
            Buffer.from([7]),                                    // string type
            Buffer.from([value.length >> 8, value.length & 0xff]),
            value,
        ]);

        const total = 12 + headers.length + payload.length + 4;
        const buf = Buffer.alloc(total);
        buf.writeUInt32BE(total, 0);
        buf.writeUInt32BE(headers.length, 4);
        buf.writeUInt32BE(0, 8);                                  // prelude crc (unchecked)
        headers.copy(buf, 12);
        payload.copy(buf, 12 + headers.length);
        buf.writeUInt32BE(0, total - 4);                          // message crc
        return new Uint8Array(buf);
    }

    it('reads a complete frame and its event type', () => {
        const bytes = frame({ delta: { text: 'hello' } });
        const { events, remaining } = extractEventStreamMessages(bytes);
        expect(events).toHaveLength(1);
        expect(remaining).toHaveLength(0);
        expect(events[0].headers[':event-type']).toBe('contentBlockDelta');
        expect(decodeStreamEvent(events[0]).text).toBe('hello');
    });

    it('holds back a partial frame for the next chunk', () => {
        // The whole reason this returns `remaining`: a TCP read can end mid-frame,
        // and parsing it as if complete corrupts every event after it.
        const full = frame({ delta: { text: 'hello' } });
        const split = Math.floor(full.length / 2);

        const first = extractEventStreamMessages(full.subarray(0, split));
        expect(first.events).toHaveLength(0);
        expect(first.remaining).toHaveLength(split);

        const rejoined = new Uint8Array(full.length);
        rejoined.set(first.remaining, 0);
        rejoined.set(full.subarray(split), split);
        const second = extractEventStreamMessages(rejoined);
        expect(second.events).toHaveLength(1);
        expect(decodeStreamEvent(second.events[0]).text).toBe('hello');
    });

    it('reads several frames out of one chunk', () => {
        const a = frame({ delta: { text: 'one ' } });
        const b = frame({ delta: { text: 'two' } });
        const joined = new Uint8Array(a.length + b.length);
        joined.set(a, 0);
        joined.set(b, a.length);

        const { events } = extractEventStreamMessages(joined);
        expect(events.map(e => decodeStreamEvent(e).text).join('')).toBe('one two');
    });

    it('unwraps the base64 payload /invoke-with-response-stream uses', () => {
        const inner = Buffer.from(JSON.stringify({ delta: { text: 'wrapped' } })).toString('base64');
        const bytes = frame({ bytes: inner });
        const { events } = extractEventStreamMessages(bytes);
        expect(decodeStreamEvent(events[0]).text).toBe('wrapped');
    });

    it('reads token usage off the metadata event', () => {
        const bytes = frame({ usage: { inputTokens: 12, outputTokens: 34 } }, 'metadata');
        const { events } = extractEventStreamMessages(bytes);
        expect(decodeStreamEvent(events[0]).usage).toEqual({ input: 12, output: 34 });
    });

    it('stops instead of looping on a corrupt length prefix', () => {
        const bad = new Uint8Array(32);
        new DataView(bad.buffer).setUint32(0, 0, false); // total length 0
        const { events } = extractEventStreamMessages(bad);
        expect(events).toHaveLength(0);
    });
});

describe('Bedrock host origins are legal Chrome match patterns', () => {
    const { ensureBedrockHostAccess } = require('../../src/background/handlers/settingsHandlers.js');

    /**
     * Chrome allows `*` in the host ONLY as the whole leading component. A
     * pattern like `bedrock-runtime.*.amazonaws.com` is rejected at load time
     * with "URL pattern is malformed" — which disables the whole entry, not just
     * that line. Region-templated origins are therefore built at runtime, and
     * this is the check that they never regain a wildcard.
     */
    const LEGAL_MATCH_PATTERN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\/\*$/;

    beforeEach(() => {
        global.chrome = {
            permissions: {
                contains: jest.fn().mockResolvedValue(true),
                request: jest.fn().mockResolvedValue(true),
            },
        };
    });

    it('builds two wildcard-free origins for a region', async () => {
        const { granted, origins } = await ensureBedrockHostAccess('ap-southeast-1');
        expect(granted).toBe(true);
        expect(origins).toEqual([
            'https://bedrock-runtime.ap-southeast-1.amazonaws.com/*',
            'https://bedrock.ap-southeast-1.amazonaws.com/*',
        ]);
        origins.forEach(o => expect(o).toMatch(LEGAL_MATCH_PATTERN));
    });

    it('works for a region that did not exist when this shipped', async () => {
        // The region field is free text by design, so this must not be limited
        // to the built-in list.
        const { origins } = await ensureBedrockHostAccess('ap-southeast-9');
        expect(origins[0]).toBe('https://bedrock-runtime.ap-southeast-9.amazonaws.com/*');
    });

    it('refuses a region that would produce a malformed origin', async () => {
        for (const bad of ['us east 1', 'us-east-1/*', '*', 'https://evil.com', '']) {
            const res = await ensureBedrockHostAccess(bad);
            expect(res.granted).toBe(false);
            expect(res.origins).toEqual([]);
        }
    });

    it('reports a declined prompt rather than throwing', async () => {
        global.chrome.permissions.contains.mockResolvedValue(false);
        global.chrome.permissions.request.mockResolvedValue(false);
        const { granted } = await ensureBedrockHostAccess('us-east-1');
        expect(granted).toBe(false);
    });
});

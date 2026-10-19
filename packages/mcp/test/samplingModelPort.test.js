import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSamplingModelPort, requestIdFor, contentText, DEFAULT_MAX_TOKENS,
} from '../src/adapters/samplingModelPort.js';
import { SAMPLING_UNAVAILABLE } from '../src/sampling.js';
import { MODEL_STATUS } from '../../../src/review-core/modelPort.js';

/** A client that advertises sampling, records each request, and answers `text`. */
function samplingServer(text, { throws = null } = {}) {
    const calls = [];
    return {
        calls,
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: async (params) => {
            calls.push(params);
            if (throws) throw throws;
            return { model: 'client-model', content: { type: 'text', text } };
        },
    };
}

const MESSAGES = [
    { role: 'system', content: 'You score findings.' },
    { role: 'user', content: 'Score this finding.' },
];

test('no sampling capability → delegated, carrying the request the host must answer', async () => {
    const port = createSamplingModelPort({ server: { getClientCapabilities: () => ({}) } });
    const schema = { type: 'object' };
    const out = await port(MESSAGES, { stage: 'rubric', priority: 'important', schema });

    assert.equal(out.status, MODEL_STATUS.DELEGATED);
    assert.equal(out.request.stage, 'rubric');
    assert.deepEqual(out.request.messages, MESSAGES);
    assert.deepEqual(out.request.schema, schema);
    assert.match(out.request.id, /^rubric:[0-9a-f]{16}$/);
});

test('no server connection at all is also delegated, never thrown', async () => {
    const out = await createSamplingModelPort({ server: null })(MESSAGES, { stage: 'rubric' });
    assert.equal(out.status, MODEL_STATUS.DELEGATED);
});

test('the delegated id is stable for the same question and differs for another', async () => {
    assert.equal(requestIdFor('rubric', MESSAGES), requestIdFor('rubric', MESSAGES));
    assert.notEqual(
        requestIdFor('rubric', MESSAGES),
        requestIdFor('rubric', [...MESSAGES, { role: 'user', content: 'again' }]),
    );
    const port = createSamplingModelPort({ server: null });
    const out = await port(MESSAGES, { stage: 'rubric', requestId: 'f-123' });
    assert.equal(out.request.id, 'f-123', 'a caller-supplied id wins');
});

test('sampling available → ok, with system and user mapped onto the MCP request', async () => {
    const server = samplingServer('{"score":90}');
    const out = await createSamplingModelPort({ server })(MESSAGES, { stage: 'rubric' });

    assert.equal(out.status, MODEL_STATUS.OK);
    assert.equal(out.text, '{"score":90}');
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].systemPrompt, 'You score findings.');
    assert.equal(server.calls[0].messages[0].content.text, 'Score this finding.');
    assert.equal(server.calls[0].maxTokens, DEFAULT_MAX_TOKENS);
});

test('a per-call maxTokens overrides the default', async () => {
    const server = samplingServer('x');
    await createSamplingModelPort({ server })(MESSAGES, { stage: 'rubric', maxTokens: 600 });
    assert.equal(server.calls[0].maxTokens, 600);
});

test('content given as cache parts is flattened byte-for-byte', async () => {
    assert.equal(contentText([{ text: 'stable\n\n', cache: true }, { text: 'tail' }]), 'stable\n\ntail');
    const server = samplingServer('x');
    await createSamplingModelPort({ server })(
        [{ role: 'user', content: [{ text: 'a', cache: true }, { text: 'b' }] }],
        { stage: 'lens:history' },
    );
    assert.equal(server.calls[0].messages[0].content.text, 'ab');
    assert.equal(server.calls[0].systemPrompt, undefined, 'no system message → no systemPrompt');
});

test('a retry conversation is rendered as a labelled transcript in one prompt', async () => {
    const server = samplingServer('x');
    await createSamplingModelPort({ server })([
        ...MESSAGES,
        { role: 'assistant', content: 'not json' },
        { role: 'user', content: 'That was invalid: score missing. Return JSON only.' },
    ], { stage: 'rubric' });
    const prompt = server.calls[0].messages[0].content.text;
    assert.match(prompt, /^\[user\]\nScore this finding\./);
    assert.match(prompt, /\[assistant\]\nnot json/);
    assert.match(prompt, /\[user\]\nThat was invalid/);
});

test('a client refusal is not-run with the reason, not an error', async () => {
    const server = samplingServer(null, { throws: new Error('user declined') });
    const out = await createSamplingModelPort({ server })(MESSAGES, { stage: 'rubric' });
    assert.equal(out.status, MODEL_STATUS.NOT_RUN);
    assert.match(out.reason, /user declined/);
});

test('an empty completion is not-run, never an ok with empty text', async () => {
    const out = await createSamplingModelPort({ server: samplingServer('   ') })(MESSAGES, { stage: 'rubric' });
    assert.equal(out.status, MODEL_STATUS.NOT_RUN);
    assert.equal(out.reason, SAMPLING_UNAVAILABLE.EMPTY);
});

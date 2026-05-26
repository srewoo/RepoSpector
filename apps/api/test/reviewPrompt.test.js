import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkUserPrompt, parseLLMReviewJson } from '../src/services/reviewPrompt.js';

test('buildChunkUserPrompt inlines brief + per-file diffs', () => {
    const out = buildChunkUserPrompt({
        chunk: {
            index: 2, total: 5,
            files: [{ filename: 'src/a.js', patch: '@@ -1 +1 @@\n+const x = 1;' }],
        },
        brief: {
            removed_exports: ['src/a.js::oldFn'],
            shared_contracts: ['protos/user.proto'],
        },
    });
    assert.match(out, /Chunk 2\/5/);
    assert.match(out, /src\/a\.js/);
    assert.match(out, /const x = 1/);
    assert.match(out, /Removed exports: src\/a\.js::oldFn/);
    assert.match(out, /Shared contracts touched: protos\/user\.proto/);
    assert.match(out, /Return JSON only/);
});

test('buildChunkUserPrompt includes dismissed-rules hints when present', () => {
    const out = buildChunkUserPrompt({
        chunk: { index: 1, total: 1, files: [] },
        brief: {},
        dismissedRules: [{ rule: 'lint:no-shadow', count: 4 }],
    });
    assert.match(out, /previously dismissed/);
    assert.match(out, /lint:no-shadow/);
});

test('buildChunkUserPrompt omits dismissed section when no history', () => {
    const out = buildChunkUserPrompt({
        chunk: { index: 1, total: 1, files: [] },
        brief: {},
    });
    assert.doesNotMatch(out, /previously dismissed/);
});

test('parseLLMReviewJson on raw JSON', () => {
    const r = parseLLMReviewJson('{"summary":"ok","findings":[]}');
    assert.equal(r.summary, 'ok');
    assert.deepEqual(r.findings, []);
});

test('parseLLMReviewJson strips ```json fences', () => {
    const r = parseLLMReviewJson('```json\n{"summary":"fenced","findings":[{"severity":"blocking","file":"a.js","line":1}]}\n```');
    assert.equal(r.summary, 'fenced');
    assert.equal(r.findings[0].severity, 'blocking');
});

test('parseLLMReviewJson recovers from leading prose', () => {
    const r = parseLLMReviewJson('Here is my review:\n{"summary":"recovered","findings":[]}');
    assert.equal(r.summary, 'recovered');
});

test('parseLLMReviewJson on garbage returns empty + flag', () => {
    const r = parseLLMReviewJson('totally not json');
    assert.deepEqual(r.findings, []);
    assert.equal(r._parseError, true);
});

test('parseLLMReviewJson on empty input', () => {
    assert.deepEqual(parseLLMReviewJson(''), { summary: '', findings: [] });
    assert.deepEqual(parseLLMReviewJson(null), { summary: '', findings: [] });
});

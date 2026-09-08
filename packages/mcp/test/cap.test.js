import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, capText, capList, allocateTokens } from '../src/tools/cap.js';

test('estimateTokens scales with length and is zero for empty', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.ok(estimateTokens('a'.repeat(4000)) > estimateTokens('a'.repeat(400)));
});

test('text under the cap is returned untouched and unflagged', () => {
    const r = capText('short', 1000);
    assert.equal(r.text, 'short');
    assert.equal(r.truncated, false);
});

test('text over the cap is truncated at a LINE boundary, never mid-line', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const r = capText(body, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < body.length);
    // A mid-line cut produces a fragment that reads as real content, which is
    // how a caller comes to reason confidently from half a function.
    const lines = body.split('\n');
    for (const line of r.text.split('\n').filter(Boolean)) {
        assert.ok(lines.includes(line), `truncation produced a partial line: ${JSON.stringify(line)}`);
    }
});

test('a truncated result says what was dropped', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const r = capText(body, 50);
    assert.match(r.note, /truncat|limit/i);
});

test('capList shows as many whole items as fit and reports the real total', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ n: i, blob: 'y'.repeat(200) }));
    const r = capList(items, (it) => `item ${it.n}: ${it.blob}`, 200);
    assert.ok(r.shown > 0, 'must show at least one item');
    assert.ok(r.shown < 40, 'must not show all 40 under a 200-token cap');
    assert.equal(r.total, 40);
    assert.equal(r.truncated, true);
    assert.match(r.text, /showing \d+ of 40/i);
});

test('capList that fits reports no truncation', () => {
    const items = [{ n: 1 }, { n: 2 }];
    const r = capList(items, (it) => `item ${it.n}`, 1000);
    assert.equal(r.truncated, false);
    assert.equal(r.shown, 2);
});

test('capList of nothing is an explicit empty result, not a blank string', () => {
    const r = capList([], () => '', 100);
    assert.equal(r.shown, 0);
    assert.equal(r.total, 0);
    assert.ok(r.text.length > 0, 'an empty result must still say it is empty');
});


// Regression: the review bundle was joined and capped once, in order, so a big
// diff let `hunks` eat the whole budget and silently deleted every section
// after it — an 8-section bundle came back with 3 labels.
test('allocateTokens gives every section what it asks for when all fit', () => {
    assert.deepEqual(allocateTokens([10, 20, 30], 100), [10, 20, 30]);
});

test('allocateTokens caps the greedy section instead of dropping later ones', () => {
    // 1000 wants far more than its share; the small ones must survive intact.
    const granted = allocateTokens([1000, 10, 10, 10], 100);
    assert.deepEqual(granted.slice(1), [10, 10, 10]);
    assert.equal(granted[0], 70, 'the oversized section takes only the leftover');
    assert.ok(granted.reduce((a, b) => a + b, 0) <= 100);
});

test('allocateTokens splits evenly when every section is oversized', () => {
    assert.deepEqual(allocateTokens([500, 500, 500], 90), [30, 30, 30]);
});

test('allocateTokens redistributes what small sections leave unused', () => {
    // 5 fits in the 50 fair share; 200 and 300 then split the remaining 95.
    const granted = allocateTokens([5, 200, 300], 100);
    assert.equal(granted[0], 5);
    assert.equal(granted[1], granted[2], 'the two oversized sections share equally');
    assert.ok(granted.reduce((a, b) => a + b, 0) <= 100);
});

test('allocateTokens handles the degenerate inputs', () => {
    assert.deepEqual(allocateTokens([], 100), []);
    assert.deepEqual(allocateTokens([10, 10], 0), [0, 0]);
    assert.deepEqual(allocateTokens([10, 10], -5), [0, 0]);
});

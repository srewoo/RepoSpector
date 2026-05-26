import test from 'node:test';
import assert from 'node:assert/strict';
import { _shouldSuppress } from '../src/services/adaptiveLearningService.js';

const opts = {
    SUPPRESS_THRESHOLD: 3,
    SUPPRESS_RATIO: 0.7,
    MIN_OBSERVATIONS: 3,
};

test('suppresses once threshold count reached', () => {
    assert.equal(_shouldSuppress({ dismissed: 3, total: 5, ratio: 0.6 }, opts), true);
    assert.equal(_shouldSuppress({ dismissed: 2, total: 5, ratio: 0.4 }, opts), false);
});

test('suppresses on high ratio once observations meet minimum', () => {
    assert.equal(_shouldSuppress({ dismissed: 7, total: 10, ratio: 0.7 }, opts), true);
    assert.equal(_shouldSuppress({ dismissed: 2, total: 2, ratio: 1.0 }, opts), false); // below MIN_OBSERVATIONS
});

test('keeps low-dismissal rules', () => {
    assert.equal(_shouldSuppress({ dismissed: 1, total: 20, ratio: 0.05 }, opts), false);
});

test('keeps balanced (accepted) rules', () => {
    assert.equal(_shouldSuppress({ dismissed: 1, total: 10, ratio: 0.1 }, opts), false);
});

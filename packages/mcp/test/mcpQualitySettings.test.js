import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpQuality, runNewLenses } from '../src/tools/reviewQuality.js';
import { NEW_LENSES } from '../../../src/review-core/lenses/index.js';

test('no settings → shared defaults: 80, all four lenses, priorPrLimit 5', () => {
    const q = resolveMcpQuality(undefined);
    assert.equal(q.minRubricScore, 80);
    assert.equal(q.lenses.length, NEW_LENSES.length);
    assert.equal(q.lensLimits.priorPrLimit, 5);
    assert.deepEqual(q.configWarnings, []);
});

test('settings override defaults and switch lenses off', () => {
    const q = resolveMcpQuality({ minRubricScore: 60, lensHistory: false, priorPrLimit: 2 });
    assert.equal(q.minRubricScore, 60);
    assert.ok(!q.lenses.some((l) => l.key === 'history'));
    assert.equal(q.lensLimits.priorPrLimit, 2);
});

test('unknown and mistyped keys become warnings, not silent drops', () => {
    const q = resolveMcpQuality({ bogus: 1, minRubricScore: 'high' });
    assert.equal(q.minRubricScore, 80);
    assert.ok(q.configWarnings.length >= 2);
});

test('a switched-off lens is reported not-run with its switch name', async () => {
    const lenses = NEW_LENSES.filter((l) => l.key !== 'history');
    const out = await runNewLenses({ lenses, contextPort: null, diffFiles: [], modelPort: async () => ({ status: 'not-run', reason: 'x' }) });
    const hist = out.lensReport.find((r) => r.lens === 'history');
    assert.deepEqual(hist, { lens: 'history', status: 'not-run', reason: 'lensHistory is false' });
});

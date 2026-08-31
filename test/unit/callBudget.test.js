/**
 * The call budget is a cost control, so its most important property is the one
 * that is easy to get wrong: running out must DEGRADE the review, never fail it,
 * and must never starve a finding-producing pass to pay for a cosmetic one.
 */

const {
    CallBudget,
    normalizeMaxAiCalls,
    PRIORITY,
    DEFAULT_MAX_AI_CALLS,
    UNLIMITED,
    MIN_MAX_AI_CALLS,
    MAX_MAX_AI_CALLS,
} = require('../../src/utils/callBudget.js');

describe('normalizeMaxAiCalls', () => {
    it('reads a number or a numeric string', () => {
        expect(normalizeMaxAiCalls(40)).toBe(40);
        expect(normalizeMaxAiCalls('40')).toBe(40);
        expect(normalizeMaxAiCalls(' 40 ')).toBe(40);
    });

    it('treats 0 and negatives as unlimited', () => {
        expect(normalizeMaxAiCalls(0)).toBe(UNLIMITED);
        expect(normalizeMaxAiCalls('0')).toBe(UNLIMITED);
        expect(normalizeMaxAiCalls(-5)).toBe(UNLIMITED);
    });

    it('falls back to the default for junk rather than to unlimited', () => {
        // A typo in a settings field must not silently remove the cost guard.
        expect(normalizeMaxAiCalls('abc')).toBe(DEFAULT_MAX_AI_CALLS);
        expect(normalizeMaxAiCalls(undefined)).toBe(DEFAULT_MAX_AI_CALLS);
        expect(normalizeMaxAiCalls('')).toBe(DEFAULT_MAX_AI_CALLS);
        expect(normalizeMaxAiCalls(NaN)).toBe(DEFAULT_MAX_AI_CALLS);
    });

    it('clamps to the supported range', () => {
        expect(normalizeMaxAiCalls(1)).toBe(MIN_MAX_AI_CALLS);
        expect(normalizeMaxAiCalls(99999)).toBe(MAX_MAX_AI_CALLS);
    });

    it('floors a fractional value', () => {
        expect(normalizeMaxAiCalls(20.7)).toBe(20);
    });
});

describe('CallBudget', () => {
    it('spends down to the limit and then refuses', () => {
        const b = new CallBudget({ limit: 10 });
        expect(b.tryConsume(6, { stage: 'per-file' })).toBe(true);
        expect(b.tryConsume(4, { stage: 'aggregate' })).toBe(true);
        expect(b.tryConsume(1, { stage: 'extra' })).toBe(false);
        expect(b.used).toBe(10);
    });

    it('refuses rather than throws, so a stage can be skipped', () => {
        const b = new CallBudget({ limit: MIN_MAX_AI_CALLS });
        expect(() => b.tryConsume(999, { stage: 'verify' })).not.toThrow();
        expect(b.tryConsume(999, { stage: 'verify' })).toBe(false);
        // Nothing was spent on the refused request.
        expect(b.used).toBe(0);
    });

    it('holds a floor back from optional stages', () => {
        // 20 * 0.15 = 3 reserved. An optional stage may spend 17, not 20.
        const b = new CallBudget({ limit: 20 });
        expect(b.availableFor(PRIORITY.OPTIONAL)).toBe(17);
        expect(b.availableFor(PRIORITY.ESSENTIAL)).toBe(20);

        expect(b.tryConsume(18, { stage: 'scoring', priority: PRIORITY.OPTIONAL })).toBe(false);
        expect(b.tryConsume(17, { stage: 'scoring', priority: PRIORITY.OPTIONAL })).toBe(true);
        // The reserved calls are still there for an essential pass.
        expect(b.tryConsume(3, { stage: 'per-file', priority: PRIORITY.ESSENTIAL })).toBe(true);
    });

    it('is all-or-nothing: a partial allowance is never granted', () => {
        const b = new CallBudget({ limit: 10 });
        b.tryConsume(8, { stage: 'per-file' });
        expect(b.tryConsume(5, { stage: 'verify' })).toBe(false);
        expect(b.used).toBe(8); // not 10
    });

    it('enforces nothing when unlimited', () => {
        const b = new CallBudget({ limit: 0 });
        expect(b.unlimited).toBe(true);
        expect(b.tryConsume(10_000, { stage: 'per-file' })).toBe(true);
        expect(b.remaining).toBe(Infinity);
        expect(b.availableFor(PRIORITY.OPTIONAL)).toBe(Infinity);
        expect(b.exhausted).toBe(false);
        // Still tracked per stage, for the stats block.
        expect(b.snapshot().byStage['per-file']).toBe(10_000);
    });

    it('gives a call back when the work turned out not to be needed', () => {
        const b = new CallBudget({ limit: 10 });
        b.tryConsume(4, { stage: 'per-file' });
        b.refund(2, 'per-file');
        expect(b.used).toBe(2);
        expect(b.snapshot().byStage['per-file']).toBe(2);
    });

    it('never refunds below zero', () => {
        const b = new CallBudget({ limit: 10 });
        b.tryConsume(1, { stage: 'x' });
        b.refund(5, 'x');
        expect(b.used).toBe(0);
        expect(b.snapshot().byStage.x).toBe(0);
    });

    it('records refusals so the review can say what it skipped', () => {
        const seen = [];
        const b = new CallBudget({ limit: 10, onRefusal: (r) => seen.push(r.stage) });
        b.tryConsume(10, { stage: 'per-file' });
        b.tryConsume(2, { stage: 'scoring', priority: PRIORITY.OPTIONAL });

        expect(seen).toEqual(['scoring']);
        expect(b.describeIfConstrained()).toContain('scoring');
        expect(b.describeIfConstrained()).toContain('10/10');
    });

    it('says nothing when it never got in the way', () => {
        const b = new CallBudget({ limit: 10 });
        b.tryConsume(3, { stage: 'per-file' });
        expect(b.describeIfConstrained()).toBe('');
    });

    it('builds from a settings object', () => {
        expect(CallBudget.fromSettings({ maxAiCalls: '25' }).limit).toBe(25);
        expect(CallBudget.fromSettings({}).limit).toBe(DEFAULT_MAX_AI_CALLS);
        expect(CallBudget.fromSettings({ maxAiCalls: 0 }).unlimited).toBe(true);
    });
});

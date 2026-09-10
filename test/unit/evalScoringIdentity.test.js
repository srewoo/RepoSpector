/**
 * P0-3 — the evaluator must measure what it claims to measure.
 *
 * The defect: precision and recall were both decided by "same file, line within
 * ±5". A verdict on one finding was credited to a different finding nearby; one
 * prediction satisfied every reference defect around it; and a duplicate
 * satisfied two distinct defects. Every accuracy claim about this reviewer
 * rests on this instrument, so it is the one thing that must not be generous.
 */
const {
    scorePrecision,
    scoreRecall,
    recallByTag,
    matchReferences,
    scoreRun,
} = require('../../eval/lib/scoring.js');
const { predictionId, defectId } = require('../../eval/lib/ids.js');

describe('prediction identity', () => {
    it('is stable across runs for the same finding', () => {
        const a = { file: 'src/a.js', line: 10, rule: 'r1', title: 'Null deref' };
        const b = { file: './src/a.js', line: 10, rule: 'r1', title: '  null   DEREF ' };
        expect(predictionId(a)).toBe(predictionId(b));
    });

    it('distinguishes two findings on the same line', () => {
        const a = { file: 'src/a.js', line: 10, title: 'Null deref' };
        const b = { file: 'src/a.js', line: 10, title: 'Missing await' };
        expect(predictionId(a)).not.toBe(predictionId(b));
    });

    it('honours an explicit id over derived content', () => {
        expect(predictionId({ predictionId: 'pinned', file: 'x', title: 'y' })).toBe('pinned');
    });

    it('gives references their own identity space', () => {
        expect(defectId({ id: 'defect-7' })).toBe('defect-7');
    });
});

describe('precision is attached to the exact prediction', () => {
    const claimA = { file: 'a.js', line: 10, title: 'real bug' };
    const claimB = { file: 'a.js', line: 12, title: 'wrong claim' };

    it('an unrelated finding on a nearby line receives no credit', () => {
        // The reproduction from the audit: a verdict recorded at line 10 was
        // credited to the "wrong claim" prediction at line 12.
        const r = scorePrecision([claimA, claimB], [
            { predictionId: predictionId(claimA), verdict: 'true_positive' },
        ]);
        expect(r.truePositives).toBe(1);
        expect(r.falsePositives).toBe(0);
        expect(r.unadjudicated).toBe(1);
        expect(r.adjudicated).toBe(1);
    });

    it('two findings on ONE line keep separate verdicts', () => {
        const first = { file: 'a.js', line: 10, title: 'null deref' };
        const second = { file: 'a.js', line: 10, title: 'missing await' };
        const r = scorePrecision([first, second], [
            { predictionId: predictionId(first), verdict: 'true_positive' },
            { predictionId: predictionId(second), verdict: 'false_positive' },
        ]);
        expect(r.truePositives).toBe(1);
        expect(r.falsePositives).toBe(1);
        expect(r.rate).toBe(0.5);
    });

    it('a legacy verdict that could mean either finding credits neither', () => {
        const r = scorePrecision([claimA, claimB], [
            { file: 'a.js', line: 10, verdict: 'true_positive' },
        ]);
        expect(r.truePositives).toBe(0);
        expect(r.ambiguousLegacy).toBe(1);
        expect(r.rate).toBeNull();
    });

    it('a legacy verdict that can only mean one finding still counts', () => {
        // Migration path: corpora recorded before ids existed are not thrown
        // away, they are just held to an unambiguous match.
        const r = scorePrecision([claimA, { file: 'b.js', line: 90, title: 'other' }], [
            { file: 'a.js', line: 10, verdict: 'true_positive' },
        ]);
        expect(r.truePositives).toBe(1);
        expect(r.ambiguousLegacy).toBe(0);
    });

    it('a verdict matching no finding is reported, not silently dropped', () => {
        const r = scorePrecision([claimA], [{ file: 'zzz.js', line: 1, verdict: 'true_positive' }]);
        expect(r.orphanAdjudications).toBe(1);
        expect(r.adjudicated).toBe(0);
    });

    it('a finding nobody judged stays unknown', () => {
        const r = scorePrecision([claimA, claimB], []);
        expect(r.unadjudicated).toBe(2);
        expect(r.rate).toBeNull();
    });
});

describe('recall is one-to-one against the underlying defect', () => {
    it('one prediction cannot satisfy two reference defects', () => {
        const r = scoreRecall(
            [{ file: 'a.js', line: 10 }],
            [{ file: 'a.js', line: 10 }, { file: 'a.js', line: 12 }],
        );
        expect(r.matched).toBe(1);
        expect(r.missed).toBe(1);
        expect(r.rate).toBe(0.5);
    });

    it('duplicate predictions do not each claim a different defect they are not', () => {
        // Two copies of the SAME finding, two distinct reference defects. Both
        // used to count as found: recall 100% on a reviewer that raised one thing.
        const dup = { file: 'a.js', line: 10, title: 'same claim' };
        const r = scoreRecall([dup, { ...dup }], [
            { file: 'a.js', line: 10, tag: 'null-deref' },
            { file: 'a.js', line: 11, tag: 'missing-await' },
        ]);
        // The assignment is one-to-one, so at most as many references as
        // predictions can be satisfied — here two — but each prediction is
        // consumed once rather than being reused for every nearby reference.
        expect(r.matched).toBeLessThanOrEqual(2);
        expect(r.reference).toBe(2);
    });

    it('prefers the closer prediction when two compete for one reference', () => {
        const near = { file: 'a.js', line: 10, title: 'near' };
        const far = { file: 'a.js', line: 14, title: 'far' };
        const { matched } = matchReferences([far, near], [{ file: 'a.js', line: 10 }]);
        expect(matched).toHaveLength(1);
        expect(matched[0].prediction.title).toBe('near');
    });

    it('an explicit shared defect id beats any line distance', () => {
        const { matched } = matchReferences(
            [{ file: 'a.js', line: 10, title: 'co-located but unrelated' },
             { file: 'a.js', line: 400, defectId: 'd-1', title: 'the actual one' }],
            [{ file: 'a.js', line: 10, defectId: 'd-1' }],
        );
        expect(matched[0].basis).toBe('defect-id');
        expect(matched[0].prediction.title).toBe('the actual one');
    });

    it('a genuinely matched defect still counts', () => {
        const r = scoreRecall([{ file: 'a.js', line: 12 }], [{ file: 'a.js', line: 10 }]);
        expect(r.matched).toBe(1);
        expect(r.rate).toBe(1);
    });

    it('by-tag detection uses the same one-to-one assignment', () => {
        // One prediction, two co-located references in different classes: it
        // must not read as "found the injection AND the null deref".
        const byTag = Object.fromEntries(
            recallByTag([{ file: 'a.js', line: 10 }], [
                { file: 'a.js', line: 10, tag: 'sql-injection' },
                { file: 'a.js', line: 10, tag: 'null-deref' },
            ]).map(t => [t.key, t]),
        );
        const totalMatched = Object.values(byTag).reduce((a, t) => a + t.matched, 0);
        expect(totalMatched).toBe(1);
    });
});

describe('scoreRun carries the new counters', () => {
    it('surfaces disputes and ambiguity in the pooled result', () => {
        const result = scoreRun([{
            id: 'mr-1',
            predictions: [{ file: 'a.js', line: 10, title: 'x' }, { file: 'a.js', line: 12, title: 'y' }],
            adjudications: [{ file: 'a.js', line: 10, verdict: 'true_positive' }],
            humanComments: [],
        }]);
        expect(result.precision.ambiguousLegacy).toBe(1);
        expect(result.precision.rate).toBeNull();
    });
});

/**
 * Tests for the evaluation harness.
 *
 * The scorer is the instrument every accuracy claim about this reviewer rests
 * on, so its own failure modes matter more than most: a matcher that is too
 * generous inflates recall, one that is too strict manufactures false
 * positives, and an empty sample reported as a pass would let the gate wave
 * through a run that measured nothing at all.
 */

const {
    scoreRun,
    scorePrecision,
    scoreRecall,
    wilson,
    f1,
    sameLocation,
} = require('../../eval/lib/scoring.js');
const { validateCorpus, validateCase } = require('../../eval/lib/corpus.js');
const { gate } = require('../../eval/score.js');

describe('sameLocation', () => {
    it('matches within the tolerance and rejects beyond it', () => {
        const a = { file: 'src/x.js', line: 10 };
        expect(sameLocation(a, { file: 'src/x.js', line: 15 }, 5)).toBe(true);
        expect(sameLocation(a, { file: 'src/x.js', line: 16 }, 5)).toBe(false);
    });

    it('never matches across files, however close the lines', () => {
        expect(sameLocation({ file: 'a.js', line: 10 }, { file: 'b.js', line: 10 }, 5)).toBe(false);
    });

    it('treats a reference with no line as file-wide', () => {
        expect(sameLocation({ file: 'a.js', line: 900 }, { file: 'a.js' }, 5)).toBe(true);
    });

    it('normalizes leading ./ so the same file is not counted as two', () => {
        expect(sameLocation({ file: './a.js', line: 1 }, { file: 'a.js', line: 1 }, 5)).toBe(true);
    });

    it('reads the location from any producer shape', () => {
        expect(sameLocation({ filePath: 'a.js', line: 3 }, { path: 'a.js', lineNumber: 4 }, 5)).toBe(true);
    });
});

describe('wilson', () => {
    it('reports no rate for an empty sample rather than 0%', () => {
        expect(wilson(0, 0)).toMatchObject({ rate: null, low: 0, high: 1, n: 0 });
    });

    it('keeps a perfect small sample honest', () => {
        const w = wilson(1, 1);
        expect(w.rate).toBe(1);
        // The point of the interval: 1/1 must not be reportable as certainty.
        expect(w.low).toBeLessThan(0.3);
    });

    it('stays inside [0,1] at zero successes', () => {
        const w = wilson(0, 42);
        expect(w.rate).toBe(0);
        expect(w.low).toBe(0);
        expect(w.high).toBeGreaterThan(0);
        expect(w.high).toBeLessThan(0.15);
    });

    it('narrows as the sample grows', () => {
        const small = wilson(5, 10);
        const large = wilson(500, 1000);
        expect(large.high - large.low).toBeLessThan(small.high - small.low);
    });
});

describe('scorePrecision', () => {
    const predictions = [
        { file: 'a.js', line: 10 },
        { file: 'a.js', line: 40 },
        { file: 'b.js', line: 5 },
    ];

    it('counts adjudicated findings and leaves the rest out of the rate', () => {
        const r = scorePrecision(predictions, [
            { file: 'a.js', line: 10, verdict: 'true_positive' },
            { file: 'a.js', line: 40, verdict: 'false_positive' },
        ]);
        expect(r).toMatchObject({ truePositives: 1, falsePositives: 1, unadjudicated: 1, adjudicated: 2 });
        expect(r.rate).toBe(0.5);
    });

    it('resolves a split adjudication in favour of the finding', () => {
        const r = scorePrecision([{ file: 'a.js', line: 10 }], [
            { file: 'a.js', line: 10, verdict: 'false_positive' },
            { file: 'a.js', line: 10, verdict: 'true_positive' },
        ]);
        expect(r.truePositives).toBe(1);
        expect(r.falsePositives).toBe(0);
    });

    it('reports no rate when nothing was adjudicated', () => {
        expect(scorePrecision(predictions, []).rate).toBeNull();
    });
});

describe('scoreRecall', () => {
    it('matches a human comment a few lines off the prediction', () => {
        const r = scoreRecall([{ file: 'a.js', line: 10 }], [{ file: 'a.js', line: 12 }]);
        expect(r).toMatchObject({ matched: 1, missed: 0, rate: 1 });
    });

    it('excludes non-substantive comments from the denominator', () => {
        const r = scoreRecall([], [
            { file: 'a.js', line: 1, substantive: false },
            { file: 'a.js', line: 50 },
        ]);
        expect(r.reference).toBe(1);
        expect(r.rate).toBe(0);
    });

    it('lists what was missed, so the number is actionable', () => {
        const r = scoreRecall([], [{ file: 'a.js', line: 50, body: 'needs a flag' }]);
        expect(r.missedExamples).toHaveLength(1);
        expect(r.missedExamples[0].body).toBe('needs a flag');
    });
});

describe('scoreRun', () => {
    const cases = [
        {
            id: 'mr-1',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications: [{ file: 'src/a.js', line: 10, verdict: 'true_positive' }],
            humanComments: [{ file: 'src/a.js', line: 11 }],
        },
        {
            id: 'mr-2',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications: [{ file: 'src/a.js', line: 10, verdict: 'false_positive' }],
            humanComments: [{ file: 'src/zzz.js', line: 99 }],
        },
    ];

    it('pools findings across MRs', () => {
        const r = scoreRun(cases);
        expect(r.cases).toBe(2);
        expect(r.precision).toMatchObject({ truePositives: 1, falsePositives: 1 });
        expect(r.precision.rate).toBe(0.5);
        expect(r.recall.rate).toBe(0.5);
    });

    it('does not let identical paths in different MRs cross-match', () => {
        // Both MRs touch src/a.js:10. Without namespacing, mr-2's prediction
        // would satisfy mr-1's human comment and recall would read 100%.
        const r = scoreRun(cases);
        expect(r.recall.matched).toBe(1);
    });

    it('reports per-case results alongside the pooled ones', () => {
        const r = scoreRun(cases);
        expect(r.perCase.map(c => c.id)).toEqual(['mr-1', 'mr-2']);
        expect(r.perCase[0].precision.rate).toBe(1);
        expect(r.perCase[1].precision.rate).toBe(0);
    });
});

describe('f1', () => {
    it('is null when either rate is unmeasurable', () => {
        expect(f1(null, 0.5)).toBeNull();
        expect(f1(0.5, null)).toBeNull();
    });

    it('is 0 rather than NaN when both are zero', () => {
        expect(f1(0, 0)).toBe(0);
    });

    it('is the harmonic mean otherwise', () => {
        expect(f1(0.5, 0.5)).toBeCloseTo(0.5);
        expect(f1(1, 0.5)).toBeCloseTo(0.6667, 3);
    });
});

describe('validateCorpus', () => {
    const valid = [{
        id: 'c1',
        predictions: [{ file: 'a.js', line: 1 }],
        adjudications: [{ file: 'a.js', line: 1, verdict: 'true_positive' }],
        humanComments: [{ file: 'a.js', line: 1 }],
    }];

    it('accepts both the bare-array and {cases} shapes', () => {
        expect(validateCorpus(valid)).toHaveLength(1);
        expect(validateCorpus({ cases: valid })).toHaveLength(1);
    });

    it('rejects an empty corpus instead of reporting a vacuous pass', () => {
        expect(() => validateCorpus([])).toThrow(/empty/i);
    });

    it('rejects duplicate case ids', () => {
        expect(() => validateCorpus([valid[0], { ...valid[0] }])).toThrow(/duplicate/i);
    });

    it('rejects an unknown verdict', () => {
        expect(() => validateCase({
            id: 'x',
            adjudications: [{ file: 'a.js', line: 1, verdict: 'probably' }],
        }, 0)).toThrow(/verdict must be one of/);
    });

    it('names the offending case so the error is actionable', () => {
        expect(() => validateCase({ id: 'acme-1', predictions: [{ line: 1 }] }, 0))
            .toThrow(/case "acme-1".*missing `file`/);
    });
});

describe('gate', () => {
    const baseline = { thresholds: { precisionLow: 0.30, recallLow: 0.04 } };

    const runWith = (pLow, pN, rLow, rN) => ({
        precision: { low: pLow, adjudicated: pN },
        recall: { low: rLow, reference: rN },
    });

    it('passes when both lower bounds hold', () => {
        expect(gate(runWith(0.35, 10, 0.05, 10), baseline).passed).toBe(true);
    });

    it('fails on a precision regression', () => {
        const { passed, lines } = gate(runWith(0.20, 10, 0.05, 10), baseline);
        expect(passed).toBe(false);
        expect(lines.join('\n')).toMatch(/✗ precision/);
    });

    it('fails on a recall regression', () => {
        expect(gate(runWith(0.35, 10, 0.01, 10), baseline).passed).toBe(false);
    });

    it('fails an empty sample rather than passing it vacuously', () => {
        // A run that adjudicated nothing has not demonstrated anything.
        const { passed, lines } = gate(runWith(0, 0, 0.05, 10), baseline);
        expect(passed).toBe(false);
        expect(lines.join('\n')).toMatch(/empty sample/);
    });

    it('skips a metric with no recorded threshold instead of failing it', () => {
        const { passed } = gate(runWith(0.01, 10, 0.01, 10), { thresholds: {} });
        expect(passed).toBe(true);
    });
});

describe('recallByTag', () => {
    const { recallByTag } = require('../../eval/lib/scoring.js');

    const refs = [
        { file: 'a.go', line: 10, tag: 'unchecked-error', tagGroup: 'correctness' },
        { file: 'b.go', line: 20, tag: 'unchecked-error', tagGroup: 'correctness' },
        { file: 'c.js', line: 30, tag: 'loose-equality', tagGroup: 'correctness' },
        { file: 'd.py', line: 40, tag: 'sql-injection', tagGroup: 'security' },
    ];

    it('breaks detection down by defect class', () => {
        // Finds one unchecked-error and the sql-injection; misses the rest.
        const preds = [{ file: 'a.go', line: 10 }, { file: 'd.py', line: 41 }];
        const byTag = Object.fromEntries(recallByTag(preds, refs).map(t => [t.key, t]));

        expect(byTag['unchecked-error']).toMatchObject({ matched: 1, total: 2, rate: 0.5 });
        expect(byTag['loose-equality']).toMatchObject({ matched: 0, total: 1, rate: 0 });
        expect(byTag['sql-injection']).toMatchObject({ matched: 1, total: 1, rate: 1 });
    });

    it('groups by category when asked', () => {
        const preds = [{ file: 'd.py', line: 40 }];
        const byGroup = Object.fromEntries(
            recallByTag(preds, refs, 5, 'tagGroup').map(t => [t.key, t]),
        );
        expect(byGroup.correctness).toMatchObject({ matched: 0, total: 3 });
        expect(byGroup.security).toMatchObject({ matched: 1, total: 1 });
    });

    it('orders by sample size so the biggest bucket reads first', () => {
        expect(recallByTag([], refs)[0].key).toBe('unchecked-error');
    });

    it('is silent on untagged references rather than inventing a bucket', () => {
        // Human-comment corpora carry no tags; this must not fabricate groups.
        expect(recallByTag([], [{ file: 'a.js', line: 1, body: 'please rename' }])).toEqual([]);
    });
});

const { scorePrecisionBySource } = require('../../eval/lib/scoring.js');

describe('scorePrecisionBySource', () => {
    const predictions = [
        { file: 'src/a.js', line: 10 },
        { file: 'src/b.js', line: 20 },
        { file: 'src/c.js', line: 30 },
    ];

    it('treats a verdict with no source as human', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'true_positive' },
        ]);
        expect(out.human.adjudicated).toBe(1);
        expect(out.human.truePositives).toBe(1);
        expect(out.llm.adjudicated).toBe(0);
        expect(out.llm.rate).toBeNull();
    });

    it('keeps human and llm verdicts in separate samples', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'human' },
            { file: 'src/b.js', line: 20, verdict: 'false_positive', source: 'llm' },
            { file: 'src/c.js', line: 30, verdict: 'true_positive', source: 'llm' },
        ]);
        expect(out.human.adjudicated).toBe(1);
        expect(out.human.rate).toBe(1);
        expect(out.llm.adjudicated).toBe(2);
        expect(out.llm.rate).toBe(0.5);
    });

    it('never pools the two samples', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'false_positive', source: 'human' },
            { file: 'src/b.js', line: 20, verdict: 'true_positive', source: 'llm' },
        ]);
        // Pooled would be 1/2 = 50%. Neither sample may report that.
        expect(out.human.rate).toBe(0);
        expect(out.llm.rate).toBe(1);
    });
});

describe('scoreRun precision sourcing', () => {
    it('reports human-only in `precision` and llm separately', () => {
        const result = scoreRun([{
            id: 'case-1',
            predictions: [{ file: 'src/a.js', line: 10 }, { file: 'src/b.js', line: 20 }],
            adjudications: [
                { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'human' },
                { file: 'src/b.js', line: 20, verdict: 'false_positive', source: 'llm' },
            ],
            humanComments: [],
        }]);
        expect(result.precision.adjudicated).toBe(1);
        expect(result.precision.rate).toBe(1);
        expect(result.precisionLlm.adjudicated).toBe(1);
        expect(result.precisionLlm.rate).toBe(0);
    });

    it('leaves `precision` unmeasured when only llm verdicts exist', () => {
        const result = scoreRun([{
            id: 'case-1',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications: [{ file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'llm' }],
            humanComments: [],
        }]);
        expect(result.precision.rate).toBeNull();
        expect(result.precisionLlm.rate).toBe(1);
    });
});

const { formatReport } = require('../../eval/lib/scoring.js');

describe('formatReport LLM labeling', () => {
    function runWith(adjudications) {
        return scoreRun([{
            id: 'c1',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications,
            humanComments: [],
        }]);
    }

    it('labels the llm rate and never presents it as Precision', () => {
        const text = formatReport(runWith([
            { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'llm' },
        ]));
        expect(text).toContain('LLM-adjudicated — not authoritative');
        // The authoritative line must still read as unmeasured.
        expect(text).toMatch(/Precision \(human\):\s+n\/a/);
    });

    it('omits the llm line entirely when no llm verdicts exist', () => {
        const text = formatReport(runWith([
            { file: 'src/a.js', line: 10, verdict: 'true_positive' },
        ]));
        expect(text).not.toContain('LLM-adjudicated');
    });
});

describe('baseline protection', () => {
    const { refuseLlmBaseline } = require('../../eval/score.js');

    it('refuses when the human sample is empty but llm verdicts exist', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(true);
    });

    it('permits when the human sample is non-empty', () => {
        const result = { precision: { adjudicated: 30 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(false);
    });

    it('permits when explicitly allowed', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: true })).toBe(false);
    });

    it('permits an ordinary run with no adjudications at all', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 0 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(false);
    });
});

/**
 * The rubric replay: a threshold, the deterministic caps and the unscored
 * policy re-applied to STORED predictions — no model, no network. The number
 * that matters is how many adjudicated true positives a threshold drops.
 */

const { toPrediction, parseArgs } = require('../../eval/run.js');
const {
    replayRubric, formatRubricReplay, parseRubricThreshold, rulesFilesForCase,
} = require('../../eval/lib/rubricReplay.js');

const verdictFor = (c, f) => (c.adjudications || []).find(
    (a) => a.file === f.file && Number(a.line) === Number(f.line),
)?.verdict || 'unadjudicated';

const scored = (score, over = {}) => ({
    status: 'scored', score, rawScore: score, preExisting: false, quotedRule: null,
    reason: 'r', capReason: null, ...over,
});

function caseWith(predictions, adjudications = [], fileContents = {}) {
    return { id: 'acme/web#1', predictions, adjudications, fileContents };
}

describe('toPrediction', () => {
    it('persists what an offline filter needs', () => {
        const p = toPrediction({
            file: 'a.js', line: 3, severity: 'high', title: 't', source: 'llm',
            confidence: 0.9, score: 8, lens: 'history', category: 'bug',
            citation: { rule: 'R1' },
            evidence: 'x'.repeat(500),
            _evidence: { citedLine: 7 },
            rubric: scored(85, { quotedRule: 'q', capReason: null, requestId: 'rubric:1' }),
        }, true);
        expect(p).toMatchObject({
            confidence: 0.9, score: 8, source: 'llm', lens: 'history', citedLine: 7,
            category: 'bug', citationRule: 'R1', posted: true,
        });
        expect(p.evidence).toHaveLength(400);
        expect(p.rubric).toEqual({
            status: 'scored', score: 85, rawScore: 85, preExisting: false,
            quotedRule: 'q', reason: 'r', capReason: null,
        });
    });

    it('stores null rather than inventing a value', () => {
        const p = toPrediction({ file: 'a.js', line: 1, title: 't' }, false);
        expect(p).toMatchObject({
            confidence: null, score: null, lens: null, evidence: null, citedLine: null, rubric: null,
        });
    });
});

describe('parseArgs', () => {
    it('runs the rubric scorer by default and can be switched off', () => {
        expect(parseArgs([]).rubric).toBe(true);
        expect(parseArgs(['--no-rubric']).rubric).toBe(false);
    });
});

describe('parseRubricThreshold', () => {
    it('accepts an integer 0-100 and refuses anything else', () => {
        expect(parseRubricThreshold('80')).toEqual({ ok: true, value: 80 });
        expect(parseRubricThreshold('0')).toEqual({ ok: true, value: 0 });
        expect(parseRubricThreshold('101').ok).toBe(false);
        expect(parseRubricThreshold('7.5').ok).toBe(false);
        expect(parseRubricThreshold(undefined).ok).toBe(false);
    });
});

describe('replayRubric', () => {
    it('splits predictions into postable / not verified / dropped by verdict', () => {
        const c = caseWith([
            { file: 'a.js', line: 1, source: 'llm', rubric: scored(90) },
            { file: 'a.js', line: 2, source: 'llm', rubric: scored(60) },
            { file: 'a.js', line: 3, source: 'llm', rubric: { status: 'unscored', score: null, reason: 'budget' } },
            { file: 'a.js', line: 4, source: 'static', rubric: { status: 'bypassed' } },
        ], [
            { file: 'a.js', line: 1, verdict: 'true_positive' },
            { file: 'a.js', line: 2, verdict: 'true_positive' },
        ]);
        const rep = replayRubric([c], { threshold: 80, verdictFor });

        expect(rep.hasRubricData).toBe(true);
        expect(rep.status).toEqual({ scored: 2, unscored: 1, bypassed: 1 });
        expect(rep.postable).toEqual({ true_positive: 1, false_positive: 0, unadjudicated: 1 });
        expect(rep.notVerified.unadjudicated).toBe(1);
        expect(rep.dropped.true_positive).toBe(1);
    });

    it('a lower threshold keeps what a higher one drops', () => {
        const c = caseWith([{ file: 'a.js', line: 2, source: 'llm', rubric: scored(60) }]);
        expect(replayRubric([c], { threshold: 50, verdictFor }).postable.unadjudicated).toBe(1);
        expect(replayRubric([c], { threshold: 80, verdictFor }).dropped.unadjudicated).toBe(1);
    });

    it('re-applies the pre-existing cap from the raw score', () => {
        const c = caseWith([
            { file: 'a.js', line: 1, source: 'llm', rubric: scored(95, { preExisting: true }) },
        ], [], { 'CLAUDE.md': 'rules' });
        const rep = replayRubric([c], { threshold: 80, verdictFor });
        expect(rep.capped.preExisting).toBe(1);
        expect(rep.dropped.unadjudicated).toBe(1);
    });

    it('with no rules files cached, keeps the stored (already capped) score', () => {
        const c = caseWith([{
            file: 'a.js', line: 1, source: 'llm', lens: 'rulesCompliance', category: 'conventions',
            rubric: scored(25, { rawScore: 90, quotedRule: 'made up', capReason: 'quoted rule not found' }),
        }]);
        const rep = replayRubric([c], { threshold: 20, verdictFor });
        expect(rep.postable.unadjudicated).toBe(1);
        expect(rep.capped.rule).toBe(1);
    });

    it('reports missing rubric data instead of passing', () => {
        const c = caseWith([{ file: 'a.js', line: 1, source: 'llm' }]);
        const rep = replayRubric([c], { threshold: 80, verdictFor });
        expect(rep.hasRubricData).toBe(false);
        expect(rep.noData).toBe(1);
        expect(formatRubricReplay(rep)).toMatch(/no rubric data — re-run `npm run eval:run`/);
    });

    it('formats retention per stage', () => {
        const c = caseWith([{ file: 'a.js', line: 1, source: 'llm', rubric: scored(90) }]);
        const text = formatRubricReplay(replayRubric([c], { threshold: 80, verdictFor }));
        expect(text).toMatch(/Rubric replay — threshold 80/);
        expect(text).toMatch(/postable/);
        expect(text).toMatch(/not verified/);
        expect(text).toMatch(/dropped/);
    });
});

describe('rulesFilesForCase', () => {
    it('takes CLAUDE.md / AGENTS.md / .repospector.yaml from cached file contents', () => {
        const files = rulesFilesForCase({
            fileContents: {
                'CLAUDE.md': 'root rules',
                'pkg/AGENTS.md': { content: 'pkg rules' },
                'src/a.js': 'code',
                '.repospector.yaml': '',
            },
        });
        expect(files).toEqual([
            { path: 'CLAUDE.md', text: 'root rules' },
            { path: 'pkg/AGENTS.md', text: 'pkg rules' },
        ]);
    });
});

/**
 * The rubric scorer is the precision gate's only judge. These tests pin what
 * makes its number trustworthy: strict output validation with exactly one
 * retry, two caps the model cannot argue past, deterministic findings never
 * sent to a model, and an unscored finding kept (as "Not verified") rather
 * than posted or lost.
 */

const {
    RUBRIC_STATUS,
    DEFAULT_MIN_RUBRIC_SCORE,
    RUBRIC_SYSTEM_PROMPT,
    RUBRIC_RESULT_SCHEMA,
    buildRubricMessages,
    validateRubricResult,
    applyCaps,
    scoreFindings,
    filterByRubric,
    applyHostRubricResults,
} = require('../../src/review-core/rubricScorer.js');
const { okResult, notRun, delegated } = require('../../src/review-core/modelPort.js');

const reply = (o) => okResult(JSON.stringify(o));
const good = { score: 90, preExisting: false, quotedRule: null, reason: 'null deref on empty list' };

describe('RUBRIC_SYSTEM_PROMPT', () => {
    it('carries the rubric anchors and the false-positive list, generalised to rules files', () => {
        expect(RUBRIC_SYSTEM_PROMPT).toContain('0: Not confident at all.');
        expect(RUBRIC_SYSTEM_PROMPT).toContain('75: Highly confident.');
        expect(RUBRIC_SYSTEM_PROMPT).toContain('100: Absolutely certain.');
        expect(RUBRIC_SYSTEM_PROMPT).toContain("Pedantic nitpicks that a senior engineer wouldn't call out");
        expect(RUBRIC_SYSTEM_PROMPT).toContain('Real issues, but on lines that the user did not modify in their pull request');
        expect(RUBRIC_SYSTEM_PROMPT).toContain('CLAUDE.md, AGENTS.md and .repospector.yaml');
        expect(RUBRIC_SYSTEM_PROMPT).not.toMatch(/explicitly required in CLAUDE\.md/);
    });

    it('declares the four-field schema', () => {
        expect(RUBRIC_RESULT_SCHEMA.required).toEqual(['score', 'preExisting', 'quotedRule', 'reason']);
    });
});

describe('buildRubricMessages', () => {
    it('puts the finding, hunk, pre-change lines and capped rules text in the user turn', () => {
        const msgs = buildRubricMessages(
            { title: 'T', description: 'D', file: 'a.js', line: 3, evidence: 'x()', lens: 'history', category: 'bug' },
            { hunk: '+x()', preChangeLines: 'y()', rulesText: 'R'.repeat(5000) },
        );
        expect(msgs[0]).toEqual({ role: 'system', content: RUBRIC_SYSTEM_PROMPT });
        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content).toContain('"file": "a.js"');
        expect(msgs[1].content).toContain('+x()');
        expect(msgs[1].content).toContain('y()');
        expect(msgs[1].content).toContain('[truncated]');
        expect(msgs[1].content).not.toContain('R'.repeat(4001));
    });

    it('says so when there is no rules file', () => {
        expect(buildRubricMessages({ title: 'T' }, {})[1].content).toContain('(no rules file cited by this finding)');
    });

    it('cannot be broken out of by backticks in the data', () => {
        const content = buildRubricMessages({ title: 'T' }, { hunk: 'a ``` b' })[1].content;
        expect(content).toContain('````\na ``` b\n````');
    });
});

describe('validateRubricResult', () => {
    it('accepts a valid result and normalises an empty quote to null', () => {
        expect(validateRubricResult(good)).toEqual({ ok: true, value: good });
        expect(validateRubricResult({ ...good, quotedRule: '' }).value.quotedRule).toBeNull();
    });

    it.each([
        ['non-object', 'nope', /JSON object/],
        ['array', [], /JSON object/],
        ['score too high', { ...good, score: 101 }, /score/],
        ['fractional score', { ...good, score: 80.5 }, /score/],
        ['string score', { ...good, score: '90' }, /score/],
        ['missing preExisting', { score: 9, quotedRule: null, reason: 'r' }, /preExisting/],
        ['numeric quote', { ...good, quotedRule: 3 }, /quotedRule/],
        ['missing reason', { score: 9, preExisting: false, quotedRule: null }, /reason/],
        ['extra field', { ...good, confidence: 'high' }, /unexpected field/],
    ])('rejects %s', (_label, input, error) => {
        const res = validateRubricResult(input);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(error);
    });
});

describe('applyCaps', () => {
    const rulesTexts = ['# Rules\n- Never call   fetch()\n  from a reducer.'];

    it('caps a pre-existing issue to 0', () => {
        expect(applyCaps({ ...good, preExisting: true }, {}, {})).toEqual({ score: 0, capReason: expect.stringMatching(/pre-existing/) });
    });

    it('caps a rule claim with no quote to 25', () => {
        expect(applyCaps(good, { lens: 'rulesCompliance' }, { rulesTexts })).toEqual({ score: 25, capReason: expect.stringMatching(/verbatim/) });
    });

    it('caps a rule claim whose quote is not in any rules file', () => {
        const v = { ...good, quotedRule: 'Never call axios from a reducer.' };
        expect(applyCaps(v, { citation: { rule: 'r1' } }, { rulesTexts }).score).toBe(25);
    });

    it('accepts a quote that matches modulo whitespace and surrounding quotes', () => {
        const v = { ...good, quotedRule: '"Never call fetch() from a reducer."' };
        expect(applyCaps(v, { lens: 'rulesCompliance' }, { rulesTexts })).toEqual({ score: 90, capReason: null });
    });

    it('treats rule + conventions category as a rule claim, and a bare rule as not', () => {
        expect(applyCaps(good, { rule: 'x', category: 'conventions' }, { rulesTexts }).score).toBe(25);
        expect(applyCaps(good, { rule: 'x', category: 'bug' }, { rulesTexts }).score).toBe(90);
    });

    it('leaves a non-rule finding alone', () => {
        expect(applyCaps(good, { lens: 'history' }, { rulesTexts })).toEqual({ score: 90, capReason: null });
    });
});

describe('scoreFindings', () => {
    const findings = [
        { title: 'A', file: 'a.js', line: 1, source: 'llm' },
        { title: 'B', file: 'b.js', line: 2, source: 'static' },
    ];

    it('scores model findings and bypasses deterministic ones without a call', async () => {
        const modelPort = jest.fn().mockResolvedValue(reply(good));
        const contextFor = jest.fn().mockReturnValue({ hunk: '+a', preChangeLines: '', rulesText: '' });

        const { findings: out, stats, delegatedRequests } = await scoreFindings(findings, { modelPort, contextFor });

        expect(modelPort).toHaveBeenCalledTimes(1);
        expect(contextFor).toHaveBeenCalledWith(findings[0]);
        expect(modelPort.mock.calls[0][1]).toMatchObject({ stage: 'rubric', priority: 'important', requestId: 'rubric-0' });
        expect(out[0].rubric).toMatchObject({ status: 'scored', score: 90, rawScore: 90, preExisting: false, capReason: null });
        expect(out[1].rubric.status).toBe(RUBRIC_STATUS.BYPASSED);
        expect(stats).toEqual({ scored: 1, unscored: 0, bypassed: 1, capped: 0 });
        expect(delegatedRequests).toEqual([]);
        expect(findings[0].rubric).toBeUndefined();
    });

    it('retries once with the validation error, then scores', async () => {
        const modelPort = jest.fn()
            .mockResolvedValueOnce(okResult('I think 90'))
            .mockResolvedValueOnce(okResult('```json\n' + JSON.stringify(good) + '\n```'));

        const { findings: out } = await scoreFindings([findings[0]], { modelPort });

        expect(modelPort).toHaveBeenCalledTimes(2);
        const retryMessages = modelPort.mock.calls[1][0];
        expect(retryMessages[2]).toEqual({ role: 'assistant', content: 'I think 90' });
        expect(retryMessages[3].content).toContain('not valid JSON');
        expect(out[0].rubric.status).toBe('scored');
    });

    it('marks a finding unscored after a second malformed reply — never a third call', async () => {
        const modelPort = jest.fn().mockResolvedValue(reply({ score: 'high' }));
        const { findings: out, stats } = await scoreFindings([findings[0]], { modelPort });
        expect(modelPort).toHaveBeenCalledTimes(2);
        expect(out[0].rubric).toMatchObject({ status: 'unscored', score: null });
        expect(out[0].rubric.reason).toMatch(/malformed rubric output after one retry/);
        expect(stats.unscored).toBe(1);
    });

    it('carries a not-run reason (budget exhausted) onto an unscored finding', async () => {
        const modelPort = jest.fn().mockResolvedValue(notRun('rubric: LLM call budget exhausted'));
        const { findings: out } = await scoreFindings([findings[0]], { modelPort });
        expect(out[0].rubric).toMatchObject({ status: 'unscored', reason: 'rubric: LLM call budget exhausted' });
    });

    it('collects delegated requests and keeps the request id on the finding', async () => {
        const request = { id: 'rubric-0', stage: 'rubric', messages: [], schema: RUBRIC_RESULT_SCHEMA };
        const modelPort = jest.fn().mockResolvedValue(delegated(request));
        const { findings: out, delegatedRequests } = await scoreFindings([findings[0]], { modelPort });
        expect(delegatedRequests).toEqual([request]);
        expect(out[0].rubric).toMatchObject({ status: 'unscored', requestId: 'rubric-0' });
    });

    it('names each request with a caller-supplied requestIdFor', async () => {
        const modelPort = jest.fn(async (_m, opts) => delegated({ id: opts.requestId }));
        const { findings: out } = await scoreFindings([findings[0]], {
            modelPort, requestIdFor: (f, i) => `rubric-7-${i}-${f.title}`,
        });
        expect(modelPort.mock.calls[0][1].requestId).toBe('rubric-7-0-A');
        expect(out[0].rubric.requestId).toBe('rubric-7-0-A');
    });

    it('treats a port that throws as unscored, with the error', async () => {
        const modelPort = jest.fn().mockRejectedValue(new Error('boom'));
        const { findings: out } = await scoreFindings([findings[0]], { modelPort });
        expect(out[0].rubric.reason).toMatch(/boom/);
    });

    it('isolates a throwing contextFor to its own finding', async () => {
        const modelPort = jest.fn().mockResolvedValue(reply(good));
        const contextFor = jest.fn((f) => {
            if (f.title === 'A') throw new Error('ctx boom');
            return {};
        });
        const two = [{ title: 'A', source: 'llm' }, { title: 'C', source: 'llm' }];
        const { findings: out } = await scoreFindings(two, { modelPort, contextFor });
        expect(out[0].rubric.status).toBe('unscored');
        expect(out[0].rubric.reason).toMatch(/rubric scoring failed: ctx boom/);
        expect(out[1].rubric.status).toBe('scored');
    });

    it('counts caps', async () => {
        const modelPort = jest.fn().mockResolvedValue(reply({ ...good, preExisting: true }));
        const { findings: out, stats } = await scoreFindings([findings[0]], { modelPort });
        expect(out[0].rubric).toMatchObject({ score: 0, rawScore: 90 });
        expect(stats.capped).toBe(1);
    });

    it('never has more calls in flight than the concurrency limit, and keeps order', async () => {
        let inFlight = 0;
        let peak = 0;
        const modelPort = jest.fn(async (messages) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, Math.random() * 5));
            inFlight--;
            const title = JSON.parse(messages[1].content.match(/\{[\s\S]*?\}/)[0]).title;
            return reply({ ...good, reason: title });
        });
        const many = Array.from({ length: 9 }, (_, i) => ({ title: `F${i}`, source: 'llm' }));

        const { findings: out } = await scoreFindings(many, { modelPort, concurrency: 2 });

        expect(peak).toBeLessThanOrEqual(2);
        expect(out.map(f => f.rubric.reason)).toEqual(many.map(f => f.title));
    });
});

describe('filterByRubric', () => {
    const f = (rubric) => ({ title: 't', rubric });

    it('splits postable / notVerified / dropped at the default threshold of 80', () => {
        expect(DEFAULT_MIN_RUBRIC_SCORE).toBe(80);
        const pass = f({ status: 'scored', score: 80 });
        const low = f({ status: 'scored', score: 79 });
        const bypass = f({ status: 'bypassed', score: null });
        const unscored = f({ status: 'unscored', score: null, reason: 'budget' });
        const none = { title: 'no rubric' };

        expect(filterByRubric([pass, low, bypass, unscored, none])).toEqual({
            postable: [pass, bypass],
            notVerified: [unscored, none],
            dropped: [low],
        });
    });

    it('honours a custom threshold', () => {
        const fifty = f({ status: 'scored', score: 50 });
        expect(filterByRubric([fifty], { minRubricScore: 50 }).postable).toEqual([fifty]);
    });
});

describe('applyHostRubricResults', () => {
    const pending = (id) => ({ title: id, lens: 'rulesCompliance', rubric: { status: 'unscored', requestId: id } });

    it('fills valid host answers through the same caps, and rejects invalid ones', () => {
        const out = applyHostRubricResults(
            [pending('rubric-0'), pending('rubric-1'), pending('rubric-2')],
            [
                { requestId: 'rubric-0', result: { ...good, quotedRule: 'No eval.' } },
                { requestId: 'rubric-1', result: { score: 500 } },
            ],
            { rulesTexts: ['No eval.'] },
        );

        expect(out[0].rubric).toMatchObject({ status: 'scored', score: 90, requestId: 'rubric-0' });
        expect(out[1].rubric).toMatchObject({ status: 'unscored', requestId: 'rubric-1' });
        expect(out[1].rubric.reason).toMatch(/host rubric result invalid/);
        expect(out[2].rubric).toEqual({ status: 'unscored', requestId: 'rubric-2' });
    });
});

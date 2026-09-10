/**
 * P1-6 — try to disprove the candidate, and record what happened.
 *
 * The stage this replaces asked the same model the same question about the same
 * diff. Measured, that refuter kept 42 of 42 findings human adjudication then
 * rejected: rephrasing a claim is not evidence about it. This stage names the
 * evidence a claim depends on, goes and gets it, and — where a runner exists
 * and the user authorized execution — checks at pinned revisions.
 *
 * The property that matters most is the negative one: an unavailable check must
 * produce `unresolved`, and `unresolved` must never read as a passed check.
 */
const {
    HypothesisValidationService,
    requiredEvidenceFor,
    VALIDATION_DEFAULTS,
} = require('../../src/services/HypothesisValidationService.js');
const {
    VALIDATION_STATUS,
    VALIDATION_BASIS,
    classifyReproduction,
    describeValidationRecord,
    validationRecord,
    executionRecord,
} = require('../../src/utils/validationRecord.js');

const bug = (over = {}) => ({
    file: 'src/pay.js',
    line: 12,
    severity: 'high',
    score: 9,
    title: 'charge() breaks the caller in src/checkout.js',
    description: 'The signature dropped `currency` and the caller still passes it.',
    ...over,
});

const provider = (impl) => ({ fetch: impl });

describe('what a claim needs before it can be believed', () => {
    it('asks for the callers when the claim is about a caller', () => {
        const kinds = requiredEvidenceFor(bug()).map((w) => w.kind);
        expect(kinds).toContain('callers');
    });

    it('asks for the enclosing function when the claim is about a guard', () => {
        const kinds = requiredEvidenceFor(bug({
            title: 'the permission check was removed',
            description: 'nothing validates the caller now',
        })).map((w) => w.kind);
        expect(kinds).toEqual(expect.arrayContaining(['enclosing-function']));
    });

    it('uses a structured claim\'s own consumer and contract', () => {
        const wants = requiredEvidenceFor({
            file: 'a.js',
            affectedConsumer: 'src/billing.js',
            expectedContract: 'docs/api.md',
        });
        expect(wants.map((w) => w.kind)).toEqual(
            expect.arrayContaining(['consumer', 'contract']),
        );
    });

    it('falls back to the enclosing function and its callers', () => {
        const kinds = requiredEvidenceFor({ file: 'a.js', line: 3, title: 'something is wrong' })
            .map((w) => w.kind);
        expect(kinds).toEqual(['enclosing-function', 'callers']);
    });

    it('never asks for the same evidence twice', () => {
        const wants = requiredEvidenceFor(bug({
            title: 'caller caller caller', description: 'callers break, callers break',
        }));
        const keys = wants.map((w) => `${w.kind}:${w.target}`);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('source-based validation', () => {
    it('confirms when every piece of evidence came back and none contradicts', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async (r) => ({
                text: 'charge(total, "USD")', location: { kind: r.kind },
            })),
        });
        const { findings, stats } = await svc.validate([bug()], { revision: 'head1', baseRevision: 'base1' });

        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.CONFIRMED);
        expect(findings[0].validation.basis).toBe(VALIDATION_BASIS.SOURCE);
        expect(stats.confirmed).toBe(1);
    });

    it('refutes on specific counterevidence, and says what it was', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => ({
                text: 'charge(total)',
                refutes: 'the caller already passes the new argument list',
            })),
        });
        const { findings } = await svc.validate([bug()], {});

        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.REFUTED);
        expect(findings[0].validation.rationale).toMatch(/already passes/);
        expect(findings[0].validation.counterevidence.length).toBeGreaterThan(0);
    });

    it('a lookup that returns nothing is MISSING evidence, not confirmation', async () => {
        // The inversion this guards against: an evidence provider that fails
        // quietly would make every unretrievable claim look confirmed.
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => null),
        });
        const { findings, stats } = await svc.validate([bug()], {});

        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
        expect(findings[0].validation.missingEvidence.length).toBeGreaterThan(0);
        expect(stats.unresolved).toBe(1);
    });

    it('a provider that throws is recorded, not swallowed', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => { throw new Error('index gone'); }),
        });
        const { findings } = await svc.validate([bug()], {});
        expect(findings[0].validation.missingEvidence.join(' ')).toMatch(/index gone/);
    });

    it('no provider at all is unresolved, and says why', async () => {
        const { findings } = await new HypothesisValidationService({}).validate([bug()], {});
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
        expect(findings[0].validation.missingEvidence.join(' ')).toMatch(/no evidence provider/);
    });
});

describe('execution is optional, and never assumed', () => {
    const withReproduction = bug({ reproduction: { command: 'npx jest pay.test.js' } });
    const okProvider = provider(async () => ({ text: 'source' }));

    const runner = (impl, over = {}) => ({
        authorized: true, isolated: true, run: impl, ...over,
    });

    it('a proposed reproduction with no runner is unresolved, NOT passed', async () => {
        const svc = new HypothesisValidationService({ evidenceProvider: okProvider });
        const { findings } = await svc.validate([withReproduction], { revision: 'h', baseRevision: 'b' });

        const v = findings[0].validation;
        expect(v.status).toBe(VALIDATION_STATUS.UNRESOLVED);
        expect(v.rationale).toMatch(/not a passed check/);
        expect(v.executions[0].available).toBe(false);
        expect(describeValidationRecord(v)).toMatch(/^unresolved/);
    });

    it('an unauthorized runner is treated as no runner', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => ({ exitStatus: 0 }), { authorized: false }),
        });
        expect(svc.canExecute()).toBe(false);
        const { findings } = await svc.validate([withReproduction], { revision: 'h', baseRevision: 'b' });
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
    });

    it('a non-isolated runner is treated as no runner', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => ({ exitStatus: 0 }), { isolated: false }),
        });
        expect(svc.canExecute()).toBe(false);
    });

    it('confirms a regression that fails at head and passes at base', async () => {
        const calls = [];
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async ({ command, revision }) => {
                calls.push({ command, revision });
                return { exitStatus: revision === 'head1' ? 1 : 0, output: 'assert failed', environment: 'sandbox' };
            }),
        });
        const { findings, stats } = await svc.validate([withReproduction], {
            revision: 'head1', baseRevision: 'base1',
        });

        const v = findings[0].validation;
        expect(v.status).toBe(VALIDATION_STATUS.CONFIRMED);
        expect(v.basis).toBe(VALIDATION_BASIS.REGRESSION);
        expect(calls.map((c) => c.revision)).toEqual(['head1', 'base1']);
        // Command, revision, environment, exit status and output all retained.
        expect(v.executions[0]).toMatchObject({
            command: 'npx jest pay.test.js', revision: 'head1', exitStatus: 1, environment: 'sandbox',
        });
        expect(stats.executions).toBe(2);
    });

    it('refutes a failure that also fails at base — that is pre-existing', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => ({ exitStatus: 1, output: 'boom' })),
        });
        const { findings } = await svc.validate([withReproduction], {
            revision: 'head1', baseRevision: 'base1',
        });
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.REFUTED);
        expect(findings[0].validation.rationale).toMatch(/pre-existing/);
    });

    it('refutes a candidate whose reproduction passes at head', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => ({ exitStatus: 0 })),
        });
        const { findings } = await svc.validate([withReproduction], {
            revision: 'head1', baseRevision: 'base1',
        });
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.REFUTED);
    });

    it('a runner that throws leaves the candidate unresolved, not confirmed', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => { throw new Error('sandbox unavailable'); }),
        });
        const { findings } = await svc.validate([withReproduction], {
            revision: 'head1', baseRevision: 'base1',
        });
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
        expect(findings[0].validation.executions[0].available).toBe(false);
    });

    it('cannot run without a pinned revision on both sides', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: okProvider,
            runner: runner(async () => ({ exitStatus: 1 })),
        });
        const { findings } = await svc.validate([withReproduction], { revision: 'head1', baseRevision: null });
        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
    });
});

describe('the loop is bounded, and says when a bound stopped it', () => {
    it('only spends on consequential candidates', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => ({ text: 'x' })),
        });
        const { findings, stats } = await svc.validate([
            bug({ severity: 'low', title: 'nit' }),
            bug({ severity: 'critical' }),
        ], {});

        expect(stats.validated).toBe(1);
        expect(findings[0].validation).toBeUndefined();
        expect(findings[1].validation).toBeDefined();
    });

    it('records candidates it could not afford to reach', async () => {
        const many = Array.from({ length: 12 }, (_, i) => bug({ score: i }));
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => ({ text: 'x' })),
        });
        const { stats } = await svc.validate(many, { limits: { maxCandidates: 3 } });

        expect(stats.validated).toBe(3);
        expect(stats.skippedForBudget).toBe(9);
    });

    it('exhausting the execution budget yields unresolved, not a verdict', async () => {
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => ({ text: 'x' })),
            runner: {
                authorized: true,
                isolated: true,
                run: async ({ revision }) => ({ exitStatus: revision === 'h' ? 1 : 0 }),
            },
        });
        const { findings } = await svc.validate(
            [bug({ reproduction: { command: 'a' } }), bug({ reproduction: { command: 'b' } })],
            { revision: 'h', baseRevision: 'b', limits: { maxExecutionsPerReview: 2 } },
        );

        expect(findings[0].validation.status).toBe(VALIDATION_STATUS.CONFIRMED);
        expect(findings[1].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
        expect(findings[1].validation.rationale).toMatch(/execution budget was exhausted/);
    });

    it('caps evidence requests per candidate', async () => {
        let calls = 0;
        const svc = new HypothesisValidationService({
            evidenceProvider: provider(async () => { calls++; return { text: 'x' }; }),
        });
        await svc.validate([bug({
            affectedConsumer: 'a.js', expectedContract: 'b.md',
            title: 'caller guard test config',
        })], { limits: { maxEvidenceRequestsPerCandidate: 2 } });

        expect(calls).toBeLessThanOrEqual(2);
    });

    it('has a default ceiling rather than an unbounded loop', () => {
        expect(VALIDATION_DEFAULTS.maxCandidates).toBeGreaterThan(0);
        expect(VALIDATION_DEFAULTS.maxExecutionsPerReview).toBeGreaterThan(0);
    });
});

describe('the record itself', () => {
    it('is unresolved when a reproduction did not run at both revisions', () => {
        expect(classifyReproduction({ exitStatus: 1 }, { exitStatus: null }).status)
            .toBe(VALIDATION_STATUS.UNRESOLVED);
    });

    it('bounds the retained output', () => {
        const rec = executionRecord({ output: 'x'.repeat(10_000) });
        expect(rec.output.length).toBe(4000);
    });

    it('normalizes an unknown status to unresolved rather than trusting it', () => {
        expect(validationRecord({ status: 'proven' }).status).toBe(VALIDATION_STATUS.UNRESOLVED);
    });

    it('never describes an absent record as passed', () => {
        expect(describeValidationRecord(null)).toBe('not validated');
    });
});

describe('representative defect classes carry a trace or a reason they could not', () => {
    /**
     * P1-6's acceptance names four classes explicitly. Each is a claim whose
     * truth turns on evidence the DIFF does not contain — which is the whole
     * reason this stage exists — so each is exercised through the evidence
     * provider rather than asserted from prose.
     */
    const provider = (impl) => ({ fetch: impl });

    const classes = [
        {
            name: 'cross-function',
            finding: bug({
                title: 'charge() breaks the caller in src/checkout.js',
                description: 'The signature dropped `currency` and the caller still passes it.',
            }),
            evidence: 'charge(total, "USD")',
        },
        {
            name: 'async',
            finding: bug({
                title: 'The write is not awaited, so the response races the commit',
                description: 'save() returns a promise and the handler returns before it settles.',
                affectedConsumer: 'src/handler.js',
                actualBehavior: 'returns before the write settles',
                expectedContract: 'the response must follow the commit',
            }),
            evidence: 'return res.json(ok);',
        },
        {
            name: 'API-contract',
            finding: bug({
                title: 'The endpoint now returns 204 where callers expect a body',
                actualBehavior: 'returns 204 with no body',
                expectedContract: 'the OpenAPI spec declares a 200 with a Record',
            }),
            evidence: 'responses: { "200": { $ref: "#/components/schemas/Record" } }',
        },
        {
            name: 'configuration',
            finding: bug({
                title: 'The new flag defaults on in production config',
                description: 'FEATURE_X is read from config and the default flips behaviour.',
            }),
            evidence: 'FEATURE_X: true',
        },
    ];

    for (const { name, finding, evidence } of classes) {
        it(`${name}: confirms only on evidence it actually fetched`, async () => {
            const requested = [];
            const svc = new HypothesisValidationService({
                evidenceProvider: provider(async (r) => {
                    requested.push(r.kind);
                    return { text: evidence, location: { kind: r.kind } };
                }),
            });
            const { findings } = await svc.validate([finding], {
                revision: 'head1', baseRevision: 'base1',
            });
            const v = findings[0].validation;

            expect(v.status).toBe(VALIDATION_STATUS.CONFIRMED);
            expect(v.basis).toBe(VALIDATION_BASIS.SOURCE);
            // The trace: what was asked for, and what came back.
            expect(requested.length).toBeGreaterThan(0);
            expect(v.evidenceObtained.length).toBeGreaterThan(0);
            expect(v.revision).toBe('head1');
        });

        it(`${name}: is unresolved — never confirmed — when that evidence is unavailable`, async () => {
            const svc = new HypothesisValidationService({
                evidenceProvider: provider(async () => null),
            });
            const { findings } = await svc.validate([finding], {});
            expect(findings[0].validation.status).toBe(VALIDATION_STATUS.UNRESOLVED);
            expect(findings[0].validation.missingEvidence.length).toBeGreaterThan(0);
        });
    }
});

describe('invalid candidate fixes are rejected', () => {
    const {
        validateFix,
        rejectInvalidFixes,
        balanceDrift,
        FIX_REJECTION,
    } = require('../../src/utils/fixValidation.js');

    const source = 'function pay(a) {\n  if (a > 0) { charge(a); }\n  return true;\n}';

    it('rejects a fix whose original is not in the file', () => {
        const v = validateFix(
            { original: 'if (a >= 0) { charge(a); }', replacement: 'if (a > 0) { charge(a); }' },
            { fileSource: source },
        );
        expect(v.valid).toBe(false);
        expect(v.reason).toBe(FIX_REJECTION.ORIGINAL_ABSENT);
    });

    it('rejects a replacement that unbalances the code it replaces', () => {
        // The regression-as-correction case: applying it breaks the file.
        const v = validateFix({ original: 'if (a > 0) { charge(a); }', replacement: 'if (a > 0) { charge(a);' });
        expect(v.valid).toBe(false);
        expect(v.reason).toBe(FIX_REJECTION.UNPARSEABLE);
        expect(balanceDrift('if (a) { b(); }', 'if (a) { b();')).toMatch(/braces/);
    });

    it('rejects a no-op dressed as a suggestion', () => {
        expect(validateFix({ original: 'x = 1;', replacement: '  x = 1;  ' }).reason)
            .toBe(FIX_REJECTION.NO_OP);
    });

    it('rejects a fix with no replacement at all', () => {
        expect(validateFix({ original: 'x = 1;', replacement: '' }).reason).toBe(FIX_REJECTION.EMPTY);
    });

    it('accepts a fix that applies cleanly', () => {
        expect(validateFix(
            { original: 'if (a > 0) { charge(a); }', replacement: 'if (a > 0) { charge(Math.abs(a)); }' },
            { fileSource: source },
        ).valid).toBe(true);
    });

    it('keeps a legitimately unbalanced fragment when the original is too', () => {
        // A hunk that opens a block and does not close it is normal; judging
        // the fragment in isolation would reject correct fixes all day.
        expect(validateFix({ original: 'if (a) {', replacement: 'if (a && b) {' }).valid).toBe(true);
    });

    it('cannot reject on absent evidence — no source means keep the fix', () => {
        expect(validateFix({ original: 'anything at all', replacement: 'something else' }).valid)
            .toBe(true);
    });

    it('removes the unusable fix and KEEPS the finding', () => {
        // A defect does not stop being real because the proposed correction
        // was wrong.
        const { findings, stats } = rejectInvalidFixes([{
            file: 'src/pay.js',
            title: 'charge() is called with a negative amount',
            suggestedFix: { original: 'not in the file', replacement: 'y = 2;' },
        }], { sourceByFile: { 'src/pay.js': source } });

        expect(findings).toHaveLength(1);
        expect(findings[0].title).toMatch(/negative amount/);
        expect(findings[0].suggestedFix).toBeUndefined();
        expect(findings[0].rejectedFix.rejectedBecause).toBe(FIX_REJECTION.ORIGINAL_ABSENT);
        expect(stats).toMatchObject({ checked: 1, rejected: 1 });
    });

    it('leaves findings that carry no fix untouched', () => {
        const { findings, stats } = rejectInvalidFixes([{ file: 'a.js', title: 'x' }]);
        expect(findings[0]).toEqual({ file: 'a.js', title: 'x' });
        expect(stats.checked).toBe(0);
    });
});

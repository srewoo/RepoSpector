/**
 * P1-8 — verification by the agent hosting MCP.
 *
 * RepoSpector generates candidates; a connected assistant investigates them
 * with evidence RepoSpector does not have; RepoSpector validates what comes
 * back. The properties worth pinning are mostly negative ones — the ways this
 * layer could quietly become a rubber stamp:
 *
 *   - Accepting a result must establish PROVENANCE, never correctness.
 *   - A timeout, a disconnected host, a malformed result or an empty response
 *     must never count as confirmation or as refutation.
 *   - Conflicting verdicts must not become a majority vote.
 *   - Candidates must be exported BEFORE model-based suppression, or the real
 *     bug that scored 6 can never be rescued.
 *   - Submitting a verification must not post anything.
 */
const {
    buildReviewSession,
    validateVerificationResult,
    applyVerification,
    candidateHash,
    VERIFICATION_STATUS,
    SESSION_SCHEMA_VERSION,
} = require('../../src/services/reviewSession.js');

const candidate = (over = {}) => ({
    id: 'c1',
    file: 'src/pay.js',
    line: 12,
    severity: 'high',
    title: 'charge() no longer accepts the currency argument its callers pass',
    description: 'The signature dropped `currency`.',
    evidence: 'function charge(amount) {',
    ...over,
});

const session = (over = {}) => buildReviewSession({
    reviewId: 'review-1',
    repository: { url: 'https://github.com/o/r/pull/9' },
    baseSha: 'base1',
    headSha: 'head1',
    candidates: [candidate()],
    ...over,
});

const result = (over = {}) => ({
    reviewId: 'review-1',
    candidateId: 'c1',
    status: VERIFICATION_STATUS.CONFIRMED,
    rationale: 'src/checkout.js:10 calls charge(total, "USD")',
    citations: [{ path: 'src/checkout.js', line: 10, quote: 'charge(total, "USD")' }],
    verifier: { name: 'claude-code', version: '1.2' },
    ...over,
});

describe('the exported session', () => {
    it('carries the pinned snapshot and a versioned schema', () => {
        const s = session();
        expect(s.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
        expect(s.snapshot).toEqual({ baseSha: 'base1', headSha: 'head1' });
    });

    it('refuses to exist without a reviewId', () => {
        expect(() => buildReviewSession({})).toThrow(/reviewId/);
    });

    it('gives each candidate a content hash that changes with the claim', () => {
        const a = candidateHash(candidate());
        const b = candidateHash(candidate({ title: 'a different claim' }));
        expect(a).not.toBe(b);
        expect(candidateHash(candidate())).toBe(a);
    });

    it('exports the structured claim, not only prose', () => {
        const s = session({
            candidates: [candidate({
                actualBehavior: 'passes two arguments',
                expectedContract: 'the new signature takes one',
            })],
        });
        expect(s.candidates[0].claim).toMatchObject({
            actualBehavior: 'passes two arguments',
            expectedContract: 'the new signature takes one',
        });
    });

    it('exports deterministically-withheld candidates with their reasons', () => {
        // The audit half: a finding the gate rejected is inspectable; one that
        // vanished is not.
        const s = session({
            withheld: [candidate({ id: 'w1', _precisionDrop: 'review-commentary' })],
        });
        expect(s.withheld[0].withheldBecause).toBe('review-commentary');
    });

    it('carries the completeness contract so "nothing else is wrong" can be judged', () => {
        const s = session({ completeness: { parseFailures: 2 } });
        expect(s.completeness.parseFailures).toBe(2);
    });
});

describe('a submitted result is checked mechanically', () => {
    it('accepts a well-formed result and says what that does NOT prove', () => {
        const check = validateVerificationResult(session(), result());
        expect(check.ok).toBe(true);
        expect(check.result.note).toMatch(/provenance, not correctness/);
    });

    it('rejects an unknown candidate id', () => {
        const check = validateVerificationResult(session(), result({ candidateId: 'nope' }));
        expect(check.ok).toBe(false);
        expect(check.errors.join(' ')).toMatch(/unknown candidateId/);
    });

    it('rejects a verdict on a candidate whose contents changed since export', () => {
        const check = validateVerificationResult(session(), result({ candidateHash: 'stale' }));
        expect(check.errors.join(' ')).toMatch(/contents changed since export/);
    });

    it('rejects a result produced against a different head', () => {
        const check = validateVerificationResult(session(), result({ snapshot: { headSha: 'other' } }));
        expect(check.errors.join(' ')).toMatch(/different head/);
    });

    it('rejects a confirmation with no citation', () => {
        const check = validateVerificationResult(session(), result({ citations: [] }));
        expect(check.errors.join(' ')).toMatch(/must cite the source/);
    });

    it('rejects a refutation with no stated counterevidence', () => {
        const check = validateVerificationResult(session(), result({
            status: VERIFICATION_STATUS.REFUTED, rationale: null, citations: [],
        }));
        expect(check.errors.join(' ')).toMatch(/what the counterevidence was/);
    });

    it('rejects an anonymous verifier', () => {
        const check = validateVerificationResult(session(), result({ verifier: {} }));
        expect(check.errors.join(' ')).toMatch(/identify itself/);
    });

    it('rejects an unrecognised status rather than coercing it', () => {
        const check = validateVerificationResult(session(), result({ status: 'probably-real' }));
        expect(check.errors.join(' ')).toMatch(/status must be one of/);
    });

    it('rejects a citation outside the file it names', () => {
        const check = validateVerificationResult(session(), result(), {
            fileLines: new Map([['src/checkout.js', 5]]),
        });
        expect(check.errors.join(' ')).toMatch(/outside that file/);
    });

    it('rejects a citation into a file this review never covered', () => {
        const check = validateVerificationResult(session(), result(), {
            fileLines: new Map([['src/other.js', 100]]),
        });
        expect(check.errors.join(' ')).toMatch(/did not cover/);
    });

    it('rejects a malformed submission instead of guessing at it', () => {
        expect(validateVerificationResult(session(), null).ok).toBe(false);
        expect(validateVerificationResult(session(), 'confirmed').ok).toBe(false);
    });
});

describe('applying verdicts', () => {
    it('makes only confirmed candidates eligible in live mode', () => {
        const s = session();
        const accepted = validateVerificationResult(s, result()).result;
        const applied = applyVerification(s, [accepted]);

        expect(applied.postable.map((c) => c.candidateId)).toEqual(['c1']);
        expect(applied.stats).toMatchObject({ confirmed: 1, refuted: 0, unresolved: 0 });
    });

    it('excludes a refuted candidate but keeps it in the record', () => {
        const s = session();
        const accepted = validateVerificationResult(s, result({
            status: VERIFICATION_STATUS.REFUTED,
            rationale: 'the caller already passes one argument',
        })).result;
        const applied = applyVerification(s, [accepted]);

        expect(applied.postable).toHaveLength(0);
        expect(applied.refuted).toHaveLength(1);
        expect(applied.candidates[0].verification.rationale).toMatch(/already passes/);
    });

    it('an unreturned verdict is unresolved — never confirmation or refutation', () => {
        const applied = applyVerification(session(), []);
        expect(applied.stats).toMatchObject({ unresolved: 1, unreturned: 1, confirmed: 0, refuted: 0 });
        expect(applied.postable).toHaveLength(0);
    });

    it('an unresolved MATERIAL candidate prevents an automatic approval', () => {
        expect(applyVerification(session(), []).blocksApproval).toBe(true);
    });

    it('an unresolved nitpick does not block approval', () => {
        const s = session({ candidates: [candidate({ severity: 'low' })] });
        expect(applyVerification(s, []).blocksApproval).toBe(false);
    });

    it('conflicting verdicts leave the candidate unresolved rather than voting', () => {
        const s = session();
        const confirmed = validateVerificationResult(s, result()).result;
        const refuted = validateVerificationResult(s, result({
            status: VERIFICATION_STATUS.REFUTED, rationale: 'guarded upstream',
        })).result;

        const applied = applyVerification(s, [confirmed, refuted]);
        expect(applied.stats.unresolved).toBe(1);
        expect(applied.candidates[0].verification.rationale).toMatch(/conflicting verdicts/);
    });

    it('repeated identical submissions are idempotent', () => {
        const s = session();
        const accepted = validateVerificationResult(s, result()).result;
        const applied = applyVerification(s, [accepted, { ...accepted }]);
        expect(applied.stats).toMatchObject({ confirmed: 1, unresolved: 0 });
    });

    it('shadow mode records decisions without changing what would be posted', () => {
        const s = session();
        const refuted = validateVerificationResult(s, result({
            status: VERIFICATION_STATUS.REFUTED, rationale: 'guarded upstream',
        })).result;

        const applied = applyVerification(s, [refuted], { shadow: true });
        // The refutation is recorded…
        expect(applied.refuted).toHaveLength(1);
        // …and the pipeline's own output is untouched, which is what makes the
        // before/after ablation possible before this layer is trusted.
        expect(applied.postable.map((c) => c.candidateId)).toEqual(['c1']);
        expect(applied.shadow).toBe(true);
    });
});

// The MCP tool surface is exercised in packages/mcp/test/verification.test.js:
// jest's babel transform does not cover packages/, and the MCP package runs its
// own ESM suite under `node --test`.

describe('the extension side of the handoff', () => {
    const { createPrReviewHandlers } = require('../../src/background/handlers/prReviewHandlers.js');

    /** Minimal service double: the handoff handlers touch none of the review path. */
    const handlers = () => createPrReviewHandlers({
        errorHandler: { logError() {} },
        prScoreCache: new Map(),
    });

    const send = () => {
        const calls = [];
        const fn = (r) => calls.push(r);
        fn.calls = calls;
        return fn;
    };

    it('exports nothing for a PR that was never reviewed, and says why', async () => {
        const s = send();
        await handlers().EXPORT_REVIEW_SESSION({ data: { prUrl: 'https://x/pull/1' } }, s);
        expect(s.calls[0].success).toBe(false);
        expect(s.calls[0].error).toMatch(/Run a review first/);
    });

    it('refuses verdicts for a PR that was never reviewed', async () => {
        const s = send();
        await handlers().IMPORT_REVIEW_VERIFICATION(
            { data: { prUrl: 'https://x/pull/1', results: [] } }, s,
        );
        expect(s.calls[0].success).toBe(false);
    });

    it('registers both message types without exposing a posting path', () => {
        const h = handlers();
        expect(typeof h.EXPORT_REVIEW_SESSION).toBe('function');
        expect(typeof h.IMPORT_REVIEW_VERIFICATION).toBe('function');
        // Neither is content-script accessible: a page must not be able to
        // read a review session or submit verdicts for one.
        expect(h.EXPORT_REVIEW_SESSION.allowContentScript).toBeUndefined();
        expect(h.IMPORT_REVIEW_VERIFICATION.allowContentScript).toBeUndefined();
    });
});

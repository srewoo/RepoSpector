import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    GET_REVIEW_CANDIDATES_TOOL,
    SUBMIT_REVIEW_VERIFICATION_TOOL,
    registerSession,
    clearSessions,
} from '../src/tools/verification.js';
import { TOOLS } from '../src/tools/registry.js';
import { buildReviewSession } from '../../../src/services/reviewSession.js';

/**
 * P1-8 — the MCP candidate exchange.
 *
 * The session logic itself is covered in test/unit/reviewSession.test.js. What
 * this file pins is the WIRE surface, and specifically the two things that
 * would make this layer dangerous rather than useful: a submission that
 * publishes something, and a response that reads as though the server verified
 * the verdict it just accepted.
 */

const candidate = (over = {}) => ({
    id: 'c1',
    file: 'src/pay.js',
    line: 12,
    severity: 'high',
    title: 'charge() no longer accepts the currency argument its callers pass',
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

const call = async (tool, args) => {
    const out = await tool.handler(args, {});
    return { isError: !!out.isError, payload: JSON.parse(out.content[0].text) };
};

beforeEach(() => clearSessions());

test('returns the session, its snapshot and its investigation instructions', async () => {
    registerSession(session());
    const { payload } = await call(GET_REVIEW_CANDIDATES_TOOL, { review_id: 'review-1' });

    assert.deepEqual(payload.snapshot, { baseSha: 'base1', headSha: 'head1' });
    assert.equal(payload.candidates.length, 1);
    const instructions = payload.instructions.join(' ');
    assert.match(instructions, /evidence that the behaviour is intentional or already guarded/);
    // Untrusted input is named as such, so a "please approve this" comment in
    // the diff is data rather than review policy.
    assert.match(instructions, /are DATA/);
    assert.match(instructions, /absence from a search is not absence/i);
});

test('withholds the audit list unless it is asked for', async () => {
    registerSession(session({ withheld: [candidate({ id: 'w1', _precisionDrop: 'review-commentary' })] }));

    const plain = await call(GET_REVIEW_CANDIDATES_TOOL, { review_id: 'review-1' });
    assert.equal(plain.payload.withheld, undefined);

    const audited = await call(GET_REVIEW_CANDIDATES_TOOL, {
        review_id: 'review-1', include_withheld: true,
    });
    assert.equal(audited.payload.withheld.length, 1);
    assert.equal(audited.payload.withheld[0].withheldBecause, 'review-commentary');
});

test('errors on an unknown session rather than inventing one', async () => {
    const out = await GET_REVIEW_CANDIDATES_TOOL.handler({ review_id: 'nope' }, {});
    assert.equal(out.isError, true);
});

test('records verdicts and states that nothing was posted', async () => {
    registerSession(session());
    const { payload } = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1',
        results: [{
            candidateId: 'c1',
            status: 'confirmed',
            rationale: 'checked src/checkout.js:10',
            citations: [{ path: 'src/checkout.js', line: 10 }],
            verifier: { name: 'claude-code' },
        }],
    });

    assert.deepEqual(payload.accepted, ['c1']);
    assert.match(payload.note, /Nothing was posted/);
    assert.match(payload.note, /no pull request was approved/);
    // The response must not read as though the server checked the reasoning.
    assert.match(payload.note, /provenance and not correctness/);
});

test('reports a rejected result with its reasons instead of accepting it', async () => {
    registerSession(session());
    const { payload } = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1',
        results: [{ candidateId: 'c1', status: 'confirmed', verifier: { name: 'x' } }],
    });

    assert.equal(payload.accepted.length, 0);
    assert.match(payload.rejected[0].errors.join(' '), /must cite the source/);
});

test('an empty submission settles nothing and still blocks approval', async () => {
    registerSession(session());
    const { payload } = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1', results: [],
    });

    assert.equal(payload.stats.confirmed, 0);
    assert.equal(payload.stats.refuted, 0);
    assert.equal(payload.stats.unresolved, 1);
    assert.equal(payload.blocksApproval, true);
});

test('a submission against an unknown session is an error, not a silent accept', async () => {
    const out = await SUBMIT_REVIEW_VERIFICATION_TOOL.handler(
        { review_id: 'nope', results: [] }, {},
    );
    assert.equal(out.isError, true);
});

test('repeated identical submissions are idempotent', async () => {
    registerSession(session());
    const body = {
        review_id: 'review-1',
        results: [{
            candidateId: 'c1',
            status: 'confirmed',
            rationale: 'checked',
            citations: [{ path: 'src/checkout.js', line: 10 }],
            verifier: { name: 'claude-code' },
        }],
    };
    await call(SUBMIT_REVIEW_VERIFICATION_TOOL, body);
    const { payload } = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, body);

    assert.equal(payload.stats.confirmed, 1);
    assert.equal(payload.stats.unresolved, 0);
});

test('conflicting verdicts leave the candidate unresolved rather than voting', async () => {
    registerSession(session());
    const base = { candidateId: 'c1', verifier: { name: 'claude-code' } };
    await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1',
        results: [{
            ...base, status: 'confirmed', rationale: 'checked',
            citations: [{ path: 'src/checkout.js', line: 10 }],
        }],
    });
    const { payload } = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1',
        results: [{ ...base, status: 'refuted', rationale: 'guarded upstream' }],
    });

    assert.equal(payload.stats.unresolved, 1);
    assert.equal(payload.stats.confirmed, 0);
});

test('review_pr keeps its evidence-only contract, and the new tools are registered', () => {
    const reviewPr = TOOLS.find((t) => t.name === 'review_pr');
    assert.match(reviewPr.description, /it does not itself write findings/);

    const names = TOOLS.map((t) => t.name);
    assert.ok(names.includes('get_review_candidates'));
    assert.ok(names.includes('submit_review_verification'));
});

test('neither new tool exposes a way to publish', () => {
    for (const tool of [GET_REVIEW_CANDIDATES_TOOL, SUBMIT_REVIEW_VERIFICATION_TOOL]) {
        const schema = JSON.stringify(tool.inputSchema);
        assert.doesNotMatch(schema, /\b(post|publish|approve|comment)\b/i,
            `${tool.name} must not accept a publishing instruction`);
    }
});

test('refuses a session that belongs to a different repository', async () => {
    // Both tools take `repo` because every tool in this server does — a client
    // working across repositories passes it on every call. Here it prevents
    // answering about repository A while the caller believes they are in B.
    registerSession(session());

    const wrong = await GET_REVIEW_CANDIDATES_TOOL.handler(
        { review_id: 'review-1', repo: '/src/somewhere/else' }, {},
    );
    assert.equal(wrong.isError, true);
    assert.match(wrong.content[0].text, /does not match the repo you named/);

    const right = await call(GET_REVIEW_CANDIDATES_TOOL, {
        review_id: 'review-1', repo: '/src/o/r',
    });
    assert.equal(right.payload.candidates.length, 1);

    // Naming no repo is not a conflict.
    const unnamed = await call(GET_REVIEW_CANDIDATES_TOOL, { review_id: 'review-1' });
    assert.equal(unnamed.payload.candidates.length, 1);
});

test('a submission for the wrong repository is refused too', async () => {
    registerSession(session());
    const out = await SUBMIT_REVIEW_VERIFICATION_TOOL.handler(
        { review_id: 'review-1', repo: '/src/somewhere/else', results: [] }, {},
    );
    assert.equal(out.isError, true);
});

test('a host agent can load an exported session and then verify against it', async () => {
    // The closed loop: RepoSpector exports, the host carries it across, this
    // server registers it, and verdicts bind to it. Before this the tools could
    // only serve sessions some other code path had registered — which, from a
    // browser extension, is none of them.
    const exported = session();
    const first = await call(GET_REVIEW_CANDIDATES_TOOL, {
        review_id: 'review-1', session: exported,
    });
    assert.equal(first.payload.candidates.length, 1);

    // Registered: a later call needs only the id.
    const second = await call(GET_REVIEW_CANDIDATES_TOOL, { review_id: 'review-1' });
    assert.equal(second.payload.candidates.length, 1);

    const verdict = await call(SUBMIT_REVIEW_VERIFICATION_TOOL, {
        review_id: 'review-1',
        results: [{
            candidateId: 'c1', status: 'confirmed', rationale: 'checked',
            citations: [{ path: 'src/checkout.js', line: 10 }],
            verifier: { name: 'claude-code' },
        }],
    });
    assert.deepEqual(verdict.payload.accepted, ['c1']);
});

test('an invented session is refused rather than served back as RepoSpector output', async () => {
    const cases = [
        [{}, /schema/i],
        [{ schemaVersion: 1, reviewId: 'someone-elses' }, /does not match the review_id/],
        [{ schemaVersion: 1, reviewId: 'review-1' }, /no `candidates` array/],
        [{ schemaVersion: 99, reviewId: 'review-1', candidates: [] }, /schema v/],
    ];
    for (const [payload, pattern] of cases) {
        const out = await GET_REVIEW_CANDIDATES_TOOL.handler(
            { review_id: 'review-1', session: payload }, {},
        );
        assert.equal(out.isError, true);
        assert.match(out.content[0].text, pattern);
    }
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    SUBMIT_REVIEW_FINDINGS_TOOL,
    beginDelegatedReview,
    delegationInstruction,
    reviewIdFor,
} from '../src/tools/delegation.js';
import { GET_REVIEW_CANDIDATES_TOOL, clearSessions, registerSession } from '../src/tools/verification.js';
import { buildRubric } from '../src/tools/rubric.js';

/**
 * The return half of `review_pr`.
 *
 * `review_pr` always handed the host a rubric and the evidence to judge it
 * against — this server holds no key and runs no model, so the host IS the
 * reasoning pass. What was missing was a way for its conclusions to come back,
 * and the cost of that gap was not cosmetic: `findings.js` marks the model pass
 * `required: true`, so with MCP sampling unavailable (every session on Claude
 * Code) every review was stamped INCOMPLETE even though a model had just read
 * the whole bundle.
 *
 * The property these tests exist to protect: ASKING is not ANSWERING. An
 * instruction in a tool result is advisory — the host may summarise it, skip
 * it, or never call back — so the contract must stay open until the submission
 * actually arrives, and a submission that admits gaps must stay incomplete.
 */

const REPO = '/tmp/some-repo';
const HEAD = 'e68ea7ad3080fa25ce2eba6a367c00dfff74f0f3';
const BASE = 'c2ac4a1ac858cd8b423756c6c686b64071e834eb';

const ctx = { config: { repo: REPO } };

const open = () => beginDelegatedReview({
    repoPath: REPO, repoName: 'demo', baseSha: BASE, headSha: HEAD,
});

const submit = (args) => SUBMIT_REVIEW_FINDINGS_TOOL.handler(args, ctx);
const parse = (r) => JSON.parse(r.content[0].text);

const goodFinding = {
    file: 'source/core/Ky.ts',
    line: 339,
    severity: 'suggestion',
    title: 'await added purely for stack fidelity',
    description: 'The extra await costs a microtask.',
    evidence: 'return await validateJsonWithSchema(jsonValue, schema);',
};

const reviewer = { name: 'claude-opus-5', version: '1m' };

beforeEach(() => clearSessions());

test('the review id is deterministic for one (repo, base, head) triple', () => {
    const a = reviewIdFor({ repoPath: REPO, baseSha: BASE, headSha: HEAD });
    const b = reviewIdFor({ repoPath: REPO, baseSha: BASE, headSha: HEAD });
    assert.equal(a, b);
    assert.notEqual(a, reviewIdFor({ repoPath: REPO, baseSha: BASE, headSha: 'other' }));
});

test('re-opening a review reuses the session rather than discarding an answer', async () => {
    const { reviewId } = open();
    await submit({ review_id: reviewId, reviewer, findings: [goodFinding] });

    // A host that re-reads the bundle before answering must not wipe what it
    // already submitted, and must be told the same id both times.
    const again = open();
    assert.equal(again.reviewId, reviewId);
    assert.equal(again.reused, true);
    assert.equal(again.session.delegation.submitted, true);
    assert.equal(again.session.delegation.findings.length, 1);
});

test('the rubric names the call and the id when a session was opened', () => {
    const { reviewId } = open();
    const rubric = buildRubric({ reviewId });
    assert.match(rubric, /submit_review_findings/);
    assert.match(rubric, new RegExp(reviewId));
    assert.match(rubric, /Finding nothing IS a result/);
    assert.match(rubric, /posts NOTHING and approves NOTHING/i);
});

test('the rubric names no call when no session could be opened', () => {
    // Never advertise a call that would fail: a bundle with no session is the
    // old behaviour, degraded but honest.
    const rubric = buildRubric({});
    assert.doesNotMatch(rubric, /submit_review_findings/);
    assert.match(rubric, /Review the changes in this bundle/);
});

test('a submission with nothing omitted closes the contract', async () => {
    const { reviewId } = open();
    const out = parse(await submit({ review_id: reviewId, reviewer, findings: [goodFinding] }));
    assert.equal(out.recorded, true);
    assert.equal(out.completeness.complete, true);
    assert.equal(out.counts.findings, 1);
    assert.equal(out.counts.evidenced, 1);
});

test('reporting nothing is a result, and is accepted as one', async () => {
    // Silence is indistinguishable from never having looked; an empty list is
    // the host saying it looked and found nothing.
    const { reviewId } = open();
    const out = parse(await submit({ review_id: reviewId, reviewer, findings: [] }));
    assert.equal(out.recorded, true);
    assert.equal(out.counts.findings, 0);
    assert.equal(out.completeness.complete, true);
    assert.match(out.note, /you reported no defects/);
    assert.match(out.note, /not that the change is correct/);
});

test('a submission that admits a gap stays incomplete', async () => {
    const { reviewId } = open();
    const out = parse(await submit({
        review_id: reviewId,
        reviewer,
        findings: [goodFinding],
        not_reviewed: [{ file: 'readme.md', reason: 'hunk trimmed to fit' }],
    }));
    assert.equal(out.recorded, true);
    assert.equal(out.completeness.complete, false);
    assert.match(out.completeness.detail, /readme\.md/);
    assert.match(out.completeness.detail, /Incomplete review/);
});

test('an unevidenced finding is recorded but counted against the review', async () => {
    const { reviewId } = open();
    const { evidence: _evidence, ...noEvidence } = goodFinding;
    const out = parse(await submit({ review_id: reviewId, reviewer, findings: [noEvidence] }));
    assert.equal(out.counts.unevidenced, 1);
    assert.equal(out.counts.evidenced, 0);
});

test('an unknown review id is refused with the way to get one', async () => {
    const r = await submit({ review_id: 'rv_nope', reviewer, findings: [] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Run review_pr first/);
});

test('findings reached at a different head are refused', async () => {
    const { reviewId } = open();
    const r = await submit({
        review_id: reviewId, reviewer, findings: [goodFinding],
        snapshot: { headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /pinned to/);
});

test('a malformed finding records nothing at all', async () => {
    const { reviewId } = open();
    const r = await submit({
        review_id: reviewId,
        reviewer,
        findings: [goodFinding, { title: 'no file here' }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Nothing was recorded/);
    assert.match(r.content[0].text, /has no `file`/);
});

test('a severity outside the canonical vocabulary is refused', async () => {
    const { reviewId } = open();
    const r = await submit({
        review_id: reviewId, reviewer,
        findings: [{ ...goodFinding, severity: 'critical' }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /blocking \| suggestion \| nitpick/);
});

test('a finding with no author is refused', async () => {
    const { reviewId } = open();
    const r = await submit({ review_id: reviewId, reviewer: { name: '  ' }, findings: [] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /reviewer\.name/);
});

test('resubmitting replaces rather than accumulating', async () => {
    const { reviewId, session } = open();
    await submit({ review_id: reviewId, reviewer, findings: [goodFinding] });
    await submit({ review_id: reviewId, reviewer, findings: [] });
    // The host answering twice is a correction, not two reviews.
    assert.equal(session.delegation.findings.length, 0);
    assert.equal(session.delegation.submitted, true);
});

test('a candidate-verification session is not a delegated review', async () => {
    registerSession({
        schemaVersion: 1,
        reviewId: 'rv_candidates',
        repository: { name: 'demo', path: REPO },
        snapshot: { baseSha: BASE, headSha: HEAD },
        candidates: [{ candidateId: 'c1' }],
        withheld: [],
    });
    const r = await submit({ review_id: 'rv_candidates', reviewer, findings: [] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /submit_review_verification/);
});

test('a delegated review is not a candidate exchange', async () => {
    const { reviewId } = open();
    const r = await GET_REVIEW_CANDIDATES_TOOL.handler({ review_id: reviewId }, ctx);
    // An empty candidate list here would read as "nothing to check".
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /submit_review_findings/);
    assert.match(r.content[0].text, /carries no candidates/);
});

test('the instruction tells the host that asking is not answering', () => {
    const text = delegationInstruction('rv_x');
    assert.match(text, /recorded INCOMPLETE until you/);
    assert.match(text, /not_reviewed/);
});

import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    SUBMIT_REVIEW_FINDINGS_TOOL, beginDelegatedReview, delegationInstruction,
} from '../src/tools/delegation.js';
import { clearSessions, getSession } from '../src/tools/verification.js';

/**
 * The rubric scorer through the delegated exchange.
 *
 * Without MCP sampling this server cannot score anything itself. The host
 * submits its findings, gets back one rubric request per finding, and answers
 * them with `rubric_scores`. Until it does, those findings are NOT VERIFIED —
 * kept, never presented as passing the threshold.
 */

const REPO = '/tmp/rubric-repo';
const HEAD = 'e68ea7ad3080fa25ce2eba6a367c00dfff74f0f3';
const BASE = 'c2ac4a1ac858cd8b423756c6c686b64071e834eb';
const RULE = 'Always pass an initial value to reduce.';

const PATCH = [
    '@@ -1,3 +1,3 @@',
    ' export function total(items) {',
    '-  return items.reduce((a, b) => a + b, 0);',
    '+  return items.reduce((a, b) => a + b);',
    ' }',
].join('\n');

const finding = {
    file: 'src/total.js',
    line: 2,
    severity: 'blocking',
    title: 'reduce without an initial value throws on []',
    description: 'total([]) throws TypeError.',
    evidence: 'return items.reduce((a, b) => a + b);',
};
const reviewer = { name: 'claude-opus-5' };
const noSampling = { config: { repo: REPO }, server: { getClientCapabilities: () => ({}) } };
const parse = (r) => JSON.parse(r.content[0].text);
const submit = (args, ctx = noSampling) => SUBMIT_REVIEW_FINDINGS_TOOL.handler(args, ctx);

const open = (extra = {}) => beginDelegatedReview({
    repoPath: REPO, repoName: 'demo', baseSha: BASE, headSha: HEAD,
    diffFiles: [{ filename: 'src/total.js', patch: PATCH }],
    ...extra,
});

async function submittedWithRequest(f = finding, extra = {}) {
    const { reviewId } = open(extra);
    const out = parse(await submit({ review_id: reviewId, reviewer, findings: [f] }));
    return { reviewId, out, requestId: out.rubric_requests[0].request_id };
}

const answer = (reviewId, request_id, over = {}) => submit({
    review_id: reviewId,
    reviewer,
    rubric_scores: [{
        request_id, score: 90, preExisting: false, quotedRule: null, reason: 'verified', ...over,
    }],
});

beforeEach(() => clearSessions());

test('without sampling, submitted findings come back with rubric requests and stay not verified', async () => {
    const { out } = await submittedWithRequest();
    assert.equal(out.recorded, true);
    assert.equal(out.rubric_requests.length, 1);
    assert.equal(out.rubric_requests[0].stage, 'rubric');
    // scoreFindings names each request; the port must keep that id, or the
    // host's answer could not be matched back to its finding.
    assert.equal(out.rubric_requests[0].request_id, 'rubric-1-0');
    assert.ok(out.rubric_requests[0].messages.length >= 2, 'the request carries the prompt to run');
    assert.equal(out.rubric.postable.length, 0);
    assert.equal(out.rubric.notVerified.length, 1);
    assert.equal(out.rubric.notVerified[0].awaiting, true);
    assert.match(out.rubric_instruction, /rubric_scores/);
    // Optional check: recorded, but does not make the delegated review incomplete.
    assert.equal(out.completeness.complete, true);
});

test('a rubric answer at or above the threshold makes the finding postable', async () => {
    const { reviewId, requestId } = await submittedWithRequest();
    const out = parse(await answer(reviewId, requestId));
    assert.deepEqual(out.rubricScores.accepted, [requestId]);
    assert.equal(out.rubric.postable.length, 1);
    assert.equal(out.rubric.postable[0].score, 90);
    assert.equal(out.rubric.notVerified.length, 0);
    assert.deepEqual(out.rubric_requests, []);
});

test('a rubric answer below the threshold drops the finding', async () => {
    const { reviewId, requestId } = await submittedWithRequest();
    const out = parse(await answer(reviewId, requestId, { score: 40 }));
    assert.equal(out.rubric.dropped.length, 1);
    assert.equal(out.rubric.postable.length, 0);
});

test('preExisting caps the score at 0, whatever the host scored', async () => {
    const { reviewId, requestId } = await submittedWithRequest();
    const out = parse(await answer(reviewId, requestId, { score: 100, preExisting: true }));
    assert.equal(out.rubric.dropped.length, 1);
    assert.equal(out.rubric.dropped[0].score, 0);
});

test('a rule claim whose quoted rule is not in a loaded rules file is capped at 25', async () => {
    const ruled = { ...finding, lens: 'rulesCompliance', quotedRule: RULE };
    const extra = { rulesFiles: [{ path: 'CLAUDE.md', text: `# Rules\n${RULE}\n` }] };

    const ok = await submittedWithRequest(ruled, extra);
    const kept = parse(await answer(ok.reviewId, ok.requestId, { quotedRule: RULE }));
    assert.equal(kept.rubric.postable.length, 1, 'a verbatim quote of a loaded rule passes');

    clearSessions();
    const bad = await submittedWithRequest(ruled, extra);
    const capped = parse(await answer(bad.reviewId, bad.requestId, { quotedRule: 'Never use reduce.' }));
    assert.equal(capped.rubric.dropped.length, 1);
    assert.equal(capped.rubric.dropped[0].score, 25);
});

test('an answer to an unknown request id is refused and nothing is applied', async () => {
    const { reviewId } = await submittedWithRequest();
    const r = await answer(reviewId, 'rubric:doesnotexist');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /unknown request_id/);
});

test('an answer to a request from an earlier submission is refused, not applied to the new finding', async () => {
    const { reviewId, requestId: stale } = await submittedWithRequest();
    const other = { ...finding, title: 'a different finding', line: 1, evidence: 'export function total(items) {' };
    const resubmitted = parse(await submit({ review_id: reviewId, reviewer, findings: [other] }));
    assert.notEqual(resubmitted.rubric_requests[0].request_id, stale);

    const r = await answer(reviewId, stale);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /unknown request_id/);
    const [kept] = getSession(reviewId).session.delegation.findings;
    assert.equal(kept.title, 'a different finding');
    assert.equal(kept.rubric.status, 'unscored', 'the stale score never landed on the new finding');
});

test('a malformed rubric answer is refused and the finding stays not verified', async () => {
    const { reviewId, requestId } = await submittedWithRequest();
    const r = await answer(reviewId, requestId, { score: 'high' });
    assert.equal(r.isError, true);
    const again = parse(await answer(reviewId, requestId));
    assert.equal(again.rubric.postable.length, 1, 'a corrected answer is still accepted');
});

test('rubric_scores before any findings submission is refused', async () => {
    const { reviewId } = open();
    const r = await answer(reviewId, 'rubric:x');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Submit `findings` first/);
});

test('a call with neither findings nor rubric_scores is refused', async () => {
    const { reviewId } = open();
    const r = await submit({ review_id: reviewId, reviewer });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /carried neither/);
});

test('findings and rubric_scores in one call are refused — answers name requests from a prior call', async () => {
    const { reviewId } = open();
    const r = await submit({ review_id: reviewId, reviewer, findings: [], rubric_scores: [] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /separate call/);
});

test('with sampling available the findings are scored in the same call', async () => {
    const sampling = {
        config: { repo: REPO },
        server: {
            getClientCapabilities: () => ({ sampling: {} }),
            createMessage: async () => ({
                model: 'm',
                content: { type: 'text', text: '{"score":95,"preExisting":false,"quotedRule":null,"reason":"checked"}' },
            }),
        },
    };
    const { reviewId } = open();
    const out = parse(await submit({ review_id: reviewId, reviewer, findings: [finding] }, sampling));
    assert.deepEqual(out.rubric_requests, []);
    assert.equal(out.rubric.postable.length, 1);
});

test('lens-tagged findings are recorded with their lens; an unknown lens is refused', async () => {
    const { reviewId, session } = open();
    await submit({ review_id: reviewId, reviewer, findings: [{ ...finding, lens: 'history' }] });
    assert.equal(session.delegation.findings[0].lens, 'history');

    const r = await submit({ review_id: reviewId, reviewer, findings: [{ ...finding, lens: 'vibes' }] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /lens "vibes"/);
});

test('rules files given to the session survive a reopen of the same review', () => {
    open({ rulesFiles: [{ path: 'CLAUDE.md', text: RULE }] });
    const again = open();
    assert.deepEqual(again.session.rulesFiles, [{ path: 'CLAUDE.md', text: RULE }]);
});

test('the reporting instruction tells the host about lenses and rubric answers', () => {
    const text = delegationInstruction('rv_x');
    assert.match(text, /lens/);
    assert.match(text, /rubric_scores/);
    assert.match(text, /Finding nothing IS a result/);
});

// I3: the hand-to-host path gates at the review's resolved minRubricScore, not
// the hard-coded default.
test('a session opened with minRubricScore 60 gates submitted findings at 60', async () => {
    const { reviewId, requestId } = await submittedWithRequest(finding, { minRubricScore: 60 });
    const out = parse(await answer(reviewId, requestId, { score: 70 }));
    assert.equal(out.rubric.minRubricScore, 60);
    assert.equal(out.rubric.postable.length, 1, '70 passes a 60 gate');
    assert.equal(getSession(reviewId).session.minRubricScore, 60);
});

test('without minRubricScore the session gates at the default 80', async () => {
    const { reviewId, requestId } = await submittedWithRequest();
    const out = parse(await answer(reviewId, requestId, { score: 70 }));
    assert.equal(out.rubric.minRubricScore, 80);
    assert.equal(out.rubric.postable.length, 0);
});

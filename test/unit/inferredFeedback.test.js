/**
 * Inferred feedback reads a verdict from a thread's own state when nobody ticked
 * a box. It is only worth having if it stays clearly separated from the explicit
 * verdicts — an accuracy figure built partly from guesses is not an accuracy
 * figure — so most of these tests are about that boundary.
 */

const { FeedbackCollectorService } = require('../../src/services/FeedbackCollectorService.js');
const { FEEDBACK_MARKER } = require('../../src/utils/feedbackFooter.js');

/** In-memory chrome.storage.local stand-in. */
function fakeStorage(initial = {}) {
    let data = { ...initial };
    return {
        get: async (keys) => {
            const wanted = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of wanted) if (k in data) out[k] = data[k];
            return out;
        },
        set: async (obj) => { data = { ...data, ...obj }; },
        _dump: () => data,
    };
}

/** A bot thread with no tick-box selected. */
function untickedThread({ resolved = false, replies = [], id = 'n1', line = 42 } = {}) {
    return {
        botNote: {
            id,
            author: 'repospector-bot',
            body: `**Broad catch** (\`no-broad-catch\`)\n\nSomething.\n\n${FEEDBACK_MARKER}\n- [ ] Valid`,
        },
        replies,
        file: 'src/a.js',
        line,
        resolved,
    };
}

function makeService(discussions, storage) {
    return new FeedbackCollectorService({
        pullRequestService: {
            fetchBotInlineDiscussions: async () => discussions,
        },
        storage,
    });
}

describe('inference from thread state', () => {
    it('infers acceptance from a resolved thread on a merged PR', async () => {
        const storage = fakeStorage();
        const svc = makeService([untickedThread({ resolved: true })], storage);

        const res = await svc.collect('http://pr/1', { prState: 'merged', repoId: 'a/b' });

        expect(res.collected).toBe(1);
        expect(res.skipped.inferred).toBe(1);
        expect(res.skipped.noTick).toBe(0);
        expect(res.rows[0]).toMatchObject({
            weight: 1,
            inferred: true,
            inferredFrom: 'resolved-on-merge',
            rule: 'no-broad-catch',
            file: 'src/a.js',
        });
    });

    it('infers rejection when a PR merged with the thread still open', async () => {
        const svc = makeService([untickedThread({ resolved: false })], fakeStorage());
        const res = await svc.collect('http://pr/1', { prState: 'merged' });

        expect(res.rows[0]).toMatchObject({ weight: -1, inferred: true, inferredFrom: 'unresolved-on-merge' });
    });

    it('infers nothing while the PR is still open', async () => {
        // Reading an unresolved thread on an open PR as a rejection would punish
        // the tool for the author not having got to it yet.
        const svc = makeService([untickedThread()], fakeStorage());
        const res = await svc.collect('http://pr/1', { prState: 'open' });

        expect(res.collected).toBe(0);
        expect(res.skipped.noTick).toBe(1);
        expect(res.skipped.inferred).toBe(0);
    });

    it('infers nothing when no PR state was supplied', async () => {
        const svc = makeService([untickedThread({ resolved: true })], fakeStorage());
        const res = await svc.collect('http://pr/1');
        expect(res.collected).toBe(0);
    });

    it('leaves an unresolved thread with a human reply alone', async () => {
        // Someone engaged in prose, which ConventionMiner reads. Calling that a
        // reject because they did not also resolve the thread is the least
        // defensible reading available.
        const svc = makeService([
            untickedThread({ resolved: false, replies: [{ author: 'alice', body: 'not really' }] }),
        ], fakeStorage());

        const res = await svc.collect('http://pr/1', { prState: 'merged' });
        expect(res.collected).toBe(0);
        expect(res.skipped.noTick).toBe(1);
    });

    it('still infers acceptance for a resolved thread that has replies', async () => {
        const svc = makeService([
            untickedThread({ resolved: true, replies: [{ author: 'alice', body: 'fixed' }] }),
        ], fakeStorage());
        const res = await svc.collect('http://pr/1', { prState: 'merged' });
        expect(res.rows[0].weight).toBe(1);
    });

    it('treats a closed PR as decided, like a merged one', async () => {
        const svc = makeService([untickedThread({ resolved: true })], fakeStorage());
        const res = await svc.collect('http://pr/1', { prState: 'closed' });
        expect(res.collected).toBe(1);
    });
});

describe('inferred rows stay out of the precision number', () => {
    it('counts them separately from explicit verdicts', async () => {
        const storage = fakeStorage();
        const svc = makeService([
            untickedThread({ resolved: true, id: 'n1' }),
            untickedThread({ resolved: false, id: 'n2' }),
        ], storage);

        await svc.collect('http://pr/1', { prState: 'merged', repoId: 'a/b' });
        const stats = await svc.getStats();

        expect(stats.inferred).toBe(2);
        expect(stats.inferredAccepted).toBe(1);
        expect(stats.inferredRejected).toBe(1);
        // The published accuracy figure comes only from verdicts a human gave.
        expect(stats.accepted).toBe(0);
        expect(stats.rejected).toBe(0);
        expect(stats.precision).toBeNull();
    });

    it('leaves precision computed from explicit rows only', async () => {
        const storage = fakeStorage({
            repospectorFeedbackLedger: [
                { rule: 'r1', weight: 1, collectedAt: Date.now() },
                { rule: 'r1', weight: -1, collectedAt: Date.now() },
                { rule: 'r1', weight: -1, inferred: true, collectedAt: Date.now() },
                { rule: 'r1', weight: -1, inferred: true, collectedAt: Date.now() },
            ],
        });
        const svc = makeService([], storage);
        const stats = await svc.getStats();

        expect(stats.accepted).toBe(1);
        expect(stats.rejected).toBe(1);
        expect(stats.precision).toBe(0.5); // not 1/4
        expect(stats.inferred).toBe(2);
    });
});

describe('inferred rejections need corroboration before training a rule down', () => {
    function withLearning(discussions) {
        const recorded = [];
        const svc = new FeedbackCollectorService({
            pullRequestService: { fetchBotInlineDiscussions: async () => discussions },
            adaptiveLearning: { recordAction: async (a) => { recorded.push(a); } },
            storage: fakeStorage(),
        });
        return { svc, recorded };
    }

    it('ignores a single inferred rejection', async () => {
        // An author can merge past a correct finding for a dozen reasons.
        const { svc, recorded } = withLearning([untickedThread({ resolved: false })]);
        await svc.collect('http://pr/1', { prState: 'merged', repoId: 'a/b' });
        expect(recorded).toEqual([]);
    });

    it('acts once the same rule was inferred-rejected twice', async () => {
        const { svc, recorded } = withLearning([
            untickedThread({ resolved: false, id: 'n1', line: 10 }),
            untickedThread({ resolved: false, id: 'n2', line: 20 }),
        ]);
        await svc.collect('http://pr/1', { prState: 'merged', repoId: 'a/b' });

        expect(recorded).toHaveLength(2);
        expect(recorded[0]).toMatchObject({
            action: 'dismiss',
            ruleId: 'no-broad-catch',
            reason: 'unresolved-on-merge',
        });
    });

    it('never trains down from an inferred ACCEPTANCE', async () => {
        const { svc, recorded } = withLearning([
            untickedThread({ resolved: true, id: 'n1' }),
            untickedThread({ resolved: true, id: 'n2' }),
        ]);
        await svc.collect('http://pr/1', { prState: 'merged', repoId: 'a/b' });
        expect(recorded).toEqual([]);
    });
});

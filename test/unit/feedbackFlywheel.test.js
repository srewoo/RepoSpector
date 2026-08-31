const {
    FEEDBACK_MARKER,
    activeOptions,
    allOptions,
    lookupOption,
    attachFeedbackFooter,
    parseFeedback,
    stripFeedbackFooter,
} = require('../../src/utils/feedbackFooter.js');
const { FeedbackCollectorService } = require('../../src/services/FeedbackCollectorService.js');

/** In-memory chrome.storage.local stand-in. */
function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        async get(key) { return key in data ? { [key]: data[key] } : {}; },
        async set(obj) { Object.assign(data, obj); },
    };
}

describe('feedback option registry', () => {
    it('exposes active options in display order', () => {
        const keys = activeOptions().map(o => o.optionKey);
        expect(keys[0]).toBe('valid_will_fix');
        expect(keys).toContain('invalid_wrong_context');
    });

    it('keeps retired options resolvable so historical ticks still parse', () => {
        // Every registered key must be resolvable whether or not it is active.
        for (const o of allOptions()) {
            expect(lookupOption(o.optionKey)).not.toBeNull();
        }
    });

    it('weights a false positive negative, a fix positive, and a wont-fix neutral', () => {
        expect(lookupOption('valid_will_fix').weight).toBe(1);
        expect(lookupOption('invalid_wrong_context').weight).toBe(-1);
        // Correct finding, deliberate non-action — must not train the rule down.
        expect(lookupOption('valid_wont_fix').weight).toBe(0);
    });
});

describe('attachFeedbackFooter', () => {
    it('renders one unticked box per active option', () => {
        const body = attachFeedbackFooter('finding text');
        for (const o of activeOptions()) expect(body).toContain(`- [ ] ${o.label}`);
    });

    it('is idempotent', () => {
        const once = attachFeedbackFooter('x');
        expect(attachFeedbackFooter(once)).toBe(once);
    });

    it('keeps the task list in its own block so GitLab renders live checkboxes', () => {
        const body = attachFeedbackFooter('x');
        const lines = body.split('\n');
        const firstBox = lines.findIndex(l => l.startsWith('- [ ]'));
        // The line immediately before the list must be blank, otherwise GitLab
        // demotes the checkboxes to static glyphs.
        expect(lines[firstBox - 1]).toBe('');
    });

    it('embeds the finding id so a tick can be tied back to its finding', () => {
        const body = attachFeedbackFooter('x', { findingId: 'f_abc123' });
        expect(parseFeedback(body).findingId).toBe('f_abc123');
    });
});

describe('parseFeedback', () => {
    const tick = (label) => attachFeedbackFooter('finding').replace(`- [ ] ${label}`, `- [x] ${label}`);

    it('returns null option when nothing is ticked', () => {
        expect(parseFeedback(attachFeedbackFooter('x')).optionKey).toBeNull();
    });

    it('returns null option when there is no footer at all', () => {
        const p = parseFeedback('a plain human comment');
        expect(p.optionKey).toBeNull();
        expect(p.multiTicked).toBe(false);
    });

    it('resolves a single ticked box to its immutable key', () => {
        expect(parseFeedback(tick('Valid — will fix')).optionKey).toBe('valid_will_fix');
    });

    it('accepts an uppercase X', () => {
        const body = tick('Valid — will fix').replace('- [x]', '- [X]');
        expect(parseFeedback(body).optionKey).toBe('valid_will_fix');
    });

    it('flags multiple ticks rather than guessing', () => {
        let body = tick('Valid — will fix');
        body = body.replace('- [ ] Needs discussion', '- [x] Needs discussion');
        const p = parseFeedback(body);
        expect(p.multiTicked).toBe(true);
        expect(p.optionKey).toBeNull();
    });

    it('flags an unrecognised label rather than dropping it silently', () => {
        const body = `${FEEDBACK_MARKER}\n\n- [x] Some label we never registered\n`;
        const p = parseFeedback(body);
        expect(p.unknownLabel).toBe(true);
        expect(p.optionKey).toBeNull();
    });

    it('ignores checkboxes that appear ABOVE the marker', () => {
        const body = `- [x] Valid — will fix\n\n${FEEDBACK_MARKER}\n\n- [ ] Needs discussion\n`;
        expect(parseFeedback(body).optionKey).toBeNull();
    });
});

describe('stripFeedbackFooter', () => {
    it('removes the footer so similarity comparison sees only the finding', () => {
        const stripped = stripFeedbackFooter(attachFeedbackFooter('the real finding text'));
        expect(stripped).toBe('the real finding text');
    });

    it('leaves a body with no footer untouched', () => {
        expect(stripFeedbackFooter('plain')).toBe('plain');
    });
});

describe('FeedbackCollectorService', () => {
    const tickedBody = (label, findingId = 'f_1') =>
        attachFeedbackFooter('🟠 **HIGH** (`no-eval`): Avoid eval', { findingId })
            .replace(`- [ ] ${label}`, `- [x] ${label}`);

    const discussion = (body, replies = []) => ({
        discussionId: 'd1',
        botNote: { id: 101, body, author: 'repospector-bot', createdAt: '2026-01-01' },
        replies,
        file: 'src/a.js',
        line: 12,
    });

    function makeService(discussions, { adaptiveLearning = null, storage = fakeStorage() } = {}) {
        return {
            storage,
            svc: new FeedbackCollectorService({
                pullRequestService: { async fetchBotInlineDiscussions() { return discussions; } },
                adaptiveLearning,
                storage,
            }),
        };
    }

    it('collects a ticked verdict with its rule and location', async () => {
        const { svc } = makeService([discussion(tickedBody('Valid — will fix'))]);
        const res = await svc.collect('http://pr/1', { repoId: 'o/r' });

        expect(res.collected).toBe(1);
        expect(res.rows[0]).toMatchObject({
            optionKey: 'valid_will_fix',
            weight: 1,
            rule: 'no-eval',
            file: 'src/a.js',
            line: 12,
            findingId: 'f_1',
        });
    });

    it('concatenates human replies as the reasoning, excluding the bot', async () => {
        const { svc } = makeService([discussion(
            tickedBody('Invalid — false positive: wrong context (reply with explanation)'),
            [
                { id: 2, body: 'this path is already guarded', author: 'alice', createdAt: '2026-01-02' },
                { id: 3, body: 'automated note', author: 'repospector-bot', createdAt: '2026-01-03' },
            ]
        )]);

        const res = await svc.collect('http://pr/1');
        expect(res.rows[0].reasoning).toContain('@alice');
        expect(res.rows[0].reasoning).toContain('already guarded');
        expect(res.rows[0].reasoning).not.toContain('automated note');
    });

    it('skips untouched, multi-ticked and unknown-label threads without recording them', async () => {
        let multi = attachFeedbackFooter('x').replace('- [ ] Valid — will fix', '- [x] Valid — will fix');
        multi = multi.replace('- [ ] Needs discussion', '- [x] Needs discussion');

        const { svc } = makeService([
            discussion(attachFeedbackFooter('untouched')),
            discussion(multi),
            discussion(`${FEEDBACK_MARKER}\n\n- [x] Unregistered label\n`),
        ]);

        const res = await svc.collect('http://pr/1');
        expect(res.collected).toBe(0);
        // `inferred` counts threads whose verdict was read from thread state
        // instead of a tick — zero here because the PR state was not supplied,
        // so nothing was decided yet. See FeedbackCollectorService._inferRow.
        expect(res.skipped).toEqual({ noTick: 1, multiTicked: 1, unknownLabel: 1, inferred: 0 });
    });

    it('down-weights a rule the team called a false positive', async () => {
        const recorded = [];
        const { svc } = makeService(
            [discussion(tickedBody('Invalid — false positive: outdated rule (reply with explanation)'))],
            { adaptiveLearning: { async recordAction(a) { recorded.push(a); } } }
        );

        await svc.collect('http://pr/1', { repoId: 'o/r' });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ action: 'dismiss', ruleId: 'no-eval', repoId: 'o/r' });
    });

    it('does NOT down-weight a correct finding the team chose not to fix', async () => {
        const recorded = [];
        const { svc } = makeService(
            [discussion(tickedBody("Valid — won't fix (reply with explanation)"))],
            { adaptiveLearning: { async recordAction(a) { recorded.push(a); } } }
        );

        await svc.collect('http://pr/1');
        expect(recorded).toHaveLength(0);
    });

    it('upserts by note id so a changed tick replaces the earlier verdict', async () => {
        const storage = fakeStorage();

        const first = makeService([discussion(tickedBody('Valid — will fix'))], { storage });
        await first.svc.collect('http://pr/1');

        const second = makeService([discussion(tickedBody('Invalid — false positive: wrong context (reply with explanation)'))], { storage });
        await second.svc.collect('http://pr/1');

        const ledger = await second.svc.getLedger();
        expect(ledger).toHaveLength(1);
        expect(ledger[0].optionKey).toBe('invalid_wrong_context');
    });

    it('reports a real precision number once verdicts exist', async () => {
        const storage = fakeStorage();
        const svc = new FeedbackCollectorService({ pullRequestService: {}, storage });

        await svc._persist([
            { noteId: 1, repoId: 'o/r', weight: 1, rule: 'a', collectedAt: Date.now() },
            { noteId: 2, repoId: 'o/r', weight: -1, rule: 'a', collectedAt: Date.now() },
            { noteId: 3, repoId: 'o/r', weight: 1, rule: 'b', collectedAt: Date.now() },
            { noteId: 4, repoId: 'o/r', weight: 0, rule: 'b', collectedAt: Date.now() },
        ]);

        const stats = await svc.getStats('o/r');
        expect(stats.accepted).toBe(2);
        expect(stats.rejected).toBe(1);
        expect(stats.neutral).toBe(1);
        expect(stats.precision).toBeCloseTo(2 / 3);
        expect(stats.byRule.a).toEqual({ accepted: 1, rejected: 1 });
    });

    it('has an undefined precision before anyone has adjudicated anything', async () => {
        const svc = new FeedbackCollectorService({ pullRequestService: {}, storage: fakeStorage() });
        expect((await svc.getStats()).precision).toBeNull();
    });

    it('is fail-open — a host error yields a zero result, not a throw', async () => {
        const svc = new FeedbackCollectorService({
            pullRequestService: { async fetchBotInlineDiscussions() { throw new Error('502'); } },
            storage: fakeStorage(),
        });
        await expect(svc.collect('http://pr/1')).resolves.toMatchObject({ collected: 0 });
    });

    it('does nothing when the host cannot list discussions at all', async () => {
        const svc = new FeedbackCollectorService({ pullRequestService: {}, storage: fakeStorage() });
        await expect(svc.collect('http://pr/1')).resolves.toMatchObject({ collected: 0 });
    });
});

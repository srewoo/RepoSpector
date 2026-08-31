/**
 * The three context changes are only worth anything if they reach the actual
 * prompt and the actual provider call. Each of them has a plausible failure mode
 * where the module works perfectly and is simply never consulted:
 *
 *   - dynamic context: `declarationsByFile` not forwarded by the engine
 *   - diff budget:     `omittedFiles` computed and not rendered
 *   - call budget:     armed on a service that ignores it
 *
 * These are the wiring tests for those three.
 */

const { buildPerFileReviewPrompt } = require('../../src/utils/multiPassPrompts.js');
const { LLMService } = require('../../src/services/LLMService.js');
const { CallBudget, PRIORITY } = require('../../src/utils/callBudget.js');

/** A file long enough that expansion is preferred over pasting it whole. */
function bigFile() {
    const lines = [];
    lines.push('const helpers = require("./helpers");');
    for (let i = 2; i <= 500; i++) lines.push(`// filler ${i}`);
    lines.push('function chargeCard(amount, currency) {');     // 501
    lines.push('    assertPositive(amount);');                  // 502
    lines.push('    const cents = amount * 100;');              // 503
    lines.push('    return gateway.charge(cents, currency);');  // 504
    lines.push('}');                                            // 505
    for (let i = 506; i <= 900; i++) lines.push(`// tail ${i}`);
    return lines.join('\n');
}

const FILE = bigFile();

const PATCH = [
    '@@ -502,3 +502,3 @@',
    '     assertPositive(amount);',
    '-    const cents = amount * 100;',
    '+    const cents = Math.round(amount * 100);',
    '     return gateway.charge(cents, currency);',
].join('\n');

// Line 503 post-change must match the patch, or expansion is (correctly) refused.
const ALIGNED_FILE = FILE.replace(
    '    const cents = amount * 100;',
    '    const cents = Math.round(amount * 100);',
);

const UNIT = {
    files: [{
        filename: 'src/billing.js',
        language: 'javascript',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: PATCH,
    }],
};

const DECLS = [{ name: 'chargeCard', label: 'Function', startLine: 501, endLine: 505 }];

function render(context) {
    return buildPerFileReviewPrompt(UNIT, context).map(p => p.text).join('\n');
}

describe('dynamic context reaches the prompt', () => {
    const fileContext = new Map([['src/billing.js', {
        fullContent: ALIGNED_FILE,
        truncated: false,
        testPath: null,
        testContent: null,
        testFileMissing: true,
    }]]);

    it('shows the enclosing function instead of the whole 900-line file', () => {
        const stats = [];
        const out = render({
            prContext: 'PR',
            fileContext,
            declarationsByFile: new Map([['src/billing.js', DECLS]]),
            onContextStats: (s) => stats.push(s),
        });

        expect(out).toContain('Context strategy: hunks expanded');
        expect(out).toContain('function chargeCard(amount, currency) {');
        // The 900 filler lines are the haystack this exists to remove.
        expect(out).not.toContain('// filler 200');
        expect(out).not.toContain('// tail 800');
        expect(stats[0].expandedFiles).toBe(1);
        expect(stats[0].fullFileFiles).toBe(0);
    });

    it('warns the model that it is not seeing the whole file', () => {
        // Without this the obvious failure mode is a finding that says something
        // is missing from the file when it is merely outside the window.
        const out = render({
            prContext: 'PR', fileContext, declarationsByFile: new Map([['src/billing.js', DECLS]]),
        });
        expect(out).toMatch(/do not assert that something is\s*absent from this file/);
    });

    it('falls back to the full file when the content cannot be trusted', () => {
        const stale = new Map([['src/billing.js', { fullContent: FILE, truncated: false }]]);
        const stats = [];
        const out = render({
            prContext: 'PR',
            fileContext: stale,
            declarationsByFile: new Map([['src/billing.js', DECLS]]),
            onContextStats: (s) => stats.push(s),
        });

        expect(out).not.toContain('Context strategy: hunks expanded');
        expect(out).toContain('Full file after the change');
        expect(stats[0].expandedFiles).toBe(0);
        expect(stats[0].fullFileFiles).toBe(1);
    });

    it('honours the off switch', () => {
        const out = render({
            prContext: 'PR',
            fileContext,
            declarationsByFile: new Map([['src/billing.js', DECLS]]),
            dynamicContext: { enabled: false },
        });
        expect(out).not.toContain('Context strategy: hunks expanded');
        expect(out).toContain('Full file after the change');
    });

    it('still expands without declarations, using a fixed window', () => {
        const stats = [];
        render({ prContext: 'PR', fileContext, onContextStats: (s) => stats.push(s) });
        expect(stats[0].expandedFiles).toBe(1);
    });

    it('accepts a plain object for declarationsByFile as well as a Map', () => {
        const out = render({
            prContext: 'PR', fileContext, declarationsByFile: { 'src/billing.js': DECLS },
        });
        expect(out).toContain('function chargeCard(amount, currency) {');
    });
});

describe('omitted files reach the prompt', () => {
    it('names files the budget dropped and forbids reasoning from their absence', () => {
        const out = render({
            prContext: 'PR',
            omittedFiles: [
                { filename: 'src/caller.js', additions: 9, deletions: 0, omittedBecause: 'budget' },
                { filename: 'src/old.js', status: 'removed' },
            ],
        });

        expect(out).toContain('src/caller.js');
        expect(out).toContain('Deleted files:');
        expect(out).toMatch(/not updated/);
    });

    it('says nothing when everything fit', () => {
        const out = render({ prContext: 'PR', omittedFiles: [] });
        expect(out).not.toContain('Files changed by this PR but NOT shown');
    });
});

describe('deletion-only hunks are stripped from the rendered diff', () => {
    it('drops a removal-only hunk but keeps the modification', () => {
        const unit = {
            files: [{
                filename: 'src/a.js',
                language: 'javascript',
                patch: [
                    '@@ -1,2 +1,2 @@',
                    '-const a = 1;',
                    '+const a = 2;',
                    ' const b = 3;',
                    '@@ -40,3 +40,0 @@',
                    '-function dead() {',
                    '-    return 1;',
                    '-}',
                ].join('\n'),
            }],
        };

        const stats = [];
        const out = buildPerFileReviewPrompt(unit, { prContext: 'PR', onContextStats: (s) => stats.push(s) })
            .map(p => p.text).join('\n');

        expect(out).toContain('const a = 2;');
        expect(out).not.toContain('function dead()');
        expect(stats[0].deletionOnlyHunksRemoved).toBe(1);
    });
});

describe('the call budget is enforced at the provider boundary', () => {
    /** callLLM with a model that resolves, but never reaching the network. */
    function svcWithBudget(limit) {
        const svc = new LLMService();
        svc.setCallBudget(new CallBudget({ limit }));
        // Every provider call is stubbed: this test is about the gate, not HTTP.
        svc._dispatchToProvider = async () => ({ content: 'ok' });
        return svc;
    }

    const REQ = { model: 'openai:gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] };

    it('lets calls through until the ceiling', async () => {
        const svc = svcWithBudget(5);
        for (let i = 0; i < 5; i++) {
            await expect(svc.callLLM(REQ, 'k', { budgetStage: 'per-file' })).resolves.toBeTruthy();
        }
        await expect(svc.callLLM(REQ, 'k', { budgetStage: 'per-file' }))
            .rejects.toThrow(/budget exhausted/i);
    });

    it('throws an identifiable error, not a provider failure', async () => {
        const svc = svcWithBudget(5);
        for (let i = 0; i < 5; i++) await svc.callLLM(REQ, 'k', {});
        let caught;
        try {
            await svc.callLLM(REQ, 'k', {});
        } catch (e) {
            caught = e;
        }
        expect(LLMService.isBudgetError(caught)).toBe(true);
        expect(caught.budget.used).toBe(5);
        // The message has to tell the user how to lift it.
        expect(caught.message).toMatch(/Settings/);
    });

    it('refuses an optional stage before an essential one', async () => {
        const svc = svcWithBudget(20); // floor = 3
        for (let i = 0; i < 17; i++) {
            await svc.callLLM(REQ, 'k', { budgetStage: 'per-file' });
        }
        await expect(svc.callLLM(REQ, 'k', {
            budgetStage: 'scoring', budgetPriority: PRIORITY.OPTIONAL,
        })).rejects.toThrow(/budget exhausted/i);

        // The reserved calls are still available to the review itself.
        await expect(svc.callLLM(REQ, 'k', { budgetStage: 'per-file' })).resolves.toBeTruthy();
    });

    it('does not meter retries as separate calls', async () => {
        const svc = new LLMService();
        const budget = new CallBudget({ limit: 5 });
        svc.setCallBudget(budget);
        svc.baseDelay = 0;

        let attempts = 0;
        svc._dispatchToProvider = async () => {
            attempts++;
            if (attempts < 3) {
                const e = new Error('rate limit');
                e.status = 429;
                throw e;
            }
            return { content: 'ok' };
        };

        await svc.callLLM(REQ, 'k', { budgetStage: 'per-file' });
        expect(attempts).toBe(3);
        // A flaky provider must not be able to eat the whole review budget.
        expect(budget.used).toBe(1);
    });

    it('is unmetered until a budget is set, and again after it is cleared', async () => {
        const svc = new LLMService();
        svc._dispatchToProvider = async () => ({ content: 'ok' });

        for (let i = 0; i < 50; i++) await svc.callLLM(REQ, 'k', {});

        svc.setCallBudget(new CallBudget({ limit: 5 }));
        for (let i = 0; i < 5; i++) await svc.callLLM(REQ, 'k', {});
        await expect(svc.callLLM(REQ, 'k', {})).rejects.toThrow(/budget exhausted/i);

        // Clearing matters: the service is a singleton on the worker, so a stale
        // budget would meter the user's next chat message against this review.
        svc.clearCallBudget();
        await expect(svc.callLLM(REQ, 'k', {})).resolves.toBeTruthy();
    });

    it('labels an unlabelled call as essential rather than refusing it', async () => {
        const svc = svcWithBudget(20);
        const budget = svc.callBudget;
        await svc.callLLM(REQ, 'k', {});
        expect(budget.snapshot().byStage.llm).toBe(1);
    });
});

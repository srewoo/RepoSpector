/**
 * The PR summary is the headline artifact of a review — the first thing the
 * reader sees. Two properties matter, and both were broken:
 *
 *   1. A large review must not starve it. As an `optional` stage it was refused
 *      once spend crossed the 15% floor, so the PRs that most need a summary
 *      (many files, many calls) were exactly the ones that silently lost it.
 *   2. When it genuinely cannot be produced, the reader must be told WHY.
 */

const { CallBudget, PRIORITY } = require('../../src/utils/callBudget.js');
const { LLMService } = require('../../src/services/LLMService.js');

describe('the summary survives a review that spends most of its budget', () => {
    /** A 17-file review on the default ceiling: heavy, but not exhausted. */
    function spentBudget({ limit, used }) {
        const budget = new CallBudget({ limit });
        for (let i = 0; i < used; i++) {
            expect(budget.tryConsume(1, { stage: 'per-file' })).toBe(true);
        }
        return budget;
    }

    it('grants the summary a call that an optional stage would be refused', () => {
        // 60-call ceiling, 55 spent: below the optional floor (9), above zero.
        const budget = spentBudget({ limit: 60, used: 55 });

        expect(budget.tryConsume(1, { stage: 'scoring', priority: PRIORITY.OPTIONAL })).toBe(false);
        expect(budget.tryConsume(1, { stage: 'summary', priority: PRIORITY.IMPORTANT })).toBe(true);
    });

    it('still refuses it when the ceiling is genuinely exhausted', () => {
        const budget = spentBudget({ limit: 60, used: 60 });
        expect(budget.tryConsume(1, { stage: 'summary', priority: PRIORITY.IMPORTANT })).toBe(false);
    });
});

describe('a refused summary is identifiable, not a generic failure', () => {
    it('raises a budget error the handler can turn into an actionable reason', async () => {
        const svc = new LLMService();
        svc.setCallBudget(new CallBudget({ limit: 5 }));
        svc._dispatchToProvider = async () => ({ content: 'ok' });

        const req = { model: 'openai:gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] };
        for (let i = 0; i < 5; i++) await svc.callLLM(req, 'k', { budgetStage: 'per-file' });

        let caught;
        try {
            await svc.callLLM(req, 'k', { budgetStage: 'summary', budgetPriority: PRIORITY.IMPORTANT });
        } catch (e) {
            caught = e;
        }

        // The handler branches on exactly this to tell the user to raise the cap,
        // rather than reporting the model as unavailable.
        expect(LLMService.isBudgetError(caught)).toBe(true);
        expect(caught.budget.byStage.summary).toBeUndefined();
    });
});

describe('a refusal is not retried', () => {
    const { BatchProcessor } = require('../../src/utils/batchProcessor.js');
    const { BUDGET_ERROR_NAME } = require('../../src/utils/callBudget.js');

    it('treats a budget refusal as non-retryable', () => {
        const bp = new BatchProcessor();
        const refusal = new Error('LLM call budget exhausted (60/60) — refused stage "per-file".');
        refusal.name = BUDGET_ERROR_NAME;

        // The ceiling will still be reached on the retry: there is nothing
        // transient to wait for, so every remaining unit used to pay a retry
        // delay to be refused a second time.
        expect(bp.isNonRetryableError(refusal)).toBe(true);
        // A genuine transport failure is still retried.
        expect(bp.isNonRetryableError(new Error('502 upstream'))).toBe(false);
    });
});

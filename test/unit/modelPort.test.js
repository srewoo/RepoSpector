/**
 * The model port is the seam between the shared review core and whichever
 * runtime answers model calls. Its one promise is that it never throws: every
 * failure is a `not-run` with a reason the review can report.
 */

const { MODEL_STATUS, okResult, notRun, delegated } = require('../../src/review-core/modelPort.js');
const { createExtensionModelPort } = require('../../src/services/adapters/extensionModelPort.js');
const { STAGE_TIERS, TIER, modelForStage } = require('../../src/utils/modelTiers.js');
const { BUDGET_ERROR_NAME, PRIORITY } = require('../../src/utils/callBudget.js');

const settings = { provider: 'openai', model: 'openai:gpt-4.1', apiKey: 'k' };
const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

describe('modelPort result constructors', () => {
    it('builds the three result shapes', () => {
        expect(okResult('hi', { input: 3, output: 4, cacheRead: 9 }))
            .toEqual({ status: MODEL_STATUS.OK, text: 'hi', usage: { input: 3, output: 4 } });
        expect(okResult('hi')).toEqual({ status: 'ok', text: 'hi' });
        expect(notRun('budget')).toEqual({ status: 'not-run', reason: 'budget' });
        expect(notRun()).toEqual({ status: 'not-run', reason: 'model call did not run' });
        const request = { id: 'r1', stage: 'rubric', messages, schema: {} };
        expect(delegated(request)).toEqual({ status: 'delegated', request });
    });
});

describe('rubric stage tier', () => {
    it('is registered LIGHT and downgrades only when a light model is set', () => {
        expect(STAGE_TIERS.rubric).toBe(TIER.LIGHT);
        expect(modelForStage({ stage: 'rubric', model: 'heavy', lightModel: 'light' }).model).toBe('light');
        expect(modelForStage({ stage: 'rubric', model: 'heavy' }).model).toBe('heavy');
    });
});

describe('createExtensionModelPort', () => {
    it('calls streamChat with the stage model, budget labels and stream:false', async () => {
        const llmService = {
            streamChat: jest.fn().mockResolvedValue({ content: '{"score":80}', usage: { input: 10, output: 2 } }),
        };
        const port = createExtensionModelPort({ llmService, settings, lightModel: 'anthropic:claude-haiku' });

        const res = await port(messages, { stage: 'rubric', priority: PRIORITY.IMPORTANT });

        expect(res).toEqual({ status: 'ok', text: '{"score":80}', usage: { input: 10, output: 2 } });
        const [sentMessages, opts] = llmService.streamChat.mock.calls[0];
        expect(sentMessages).toBe(messages);
        expect(opts).toMatchObject({
            model: 'anthropic:claude-haiku',
            apiKey: 'k',
            stream: false,
            budgetStage: 'rubric',
            budgetPriority: 'important',
        });
        // A prefixed light model must not travel with a contradicting provider.
        expect(opts.provider).toBeUndefined();
    });

    it('uses settings.lightModel when no explicit lightModel is passed', async () => {
        const llmService = { streamChat: jest.fn().mockResolvedValue({ content: 'x' }) };
        const port = createExtensionModelPort({ llmService, settings: { ...settings, lightModel: 'openai:gpt-4.1-mini' } });
        await port(messages, { stage: 'rubric', priority: 'important' });
        expect(llmService.streamChat.mock.calls[0][1].model).toBe('openai:gpt-4.1-mini');
    });

    it('accepts a bare string response', async () => {
        const llmService = { streamChat: jest.fn().mockResolvedValue('plain') };
        const res = await createExtensionModelPort({ llmService, settings })(messages, { stage: 'rubric' });
        expect(res).toEqual({ status: 'ok', text: 'plain' });
    });

    it('turns a budget refusal into not-run, not an exception', async () => {
        const err = new Error('LLM call budget exhausted (150/150)');
        err.name = BUDGET_ERROR_NAME;
        const llmService = { streamChat: jest.fn().mockRejectedValue(err) };
        const res = await createExtensionModelPort({ llmService, settings })(messages, { stage: 'rubric' });
        expect(res).toEqual({ status: 'not-run', reason: 'rubric: LLM call budget exhausted' });
    });

    it('turns a provider error into not-run carrying the message', async () => {
        const llmService = { streamChat: jest.fn().mockRejectedValue(new Error('HTTP 502')) };
        const res = await createExtensionModelPort({ llmService, settings })(messages, { stage: 'finder' });
        expect(res.status).toBe('not-run');
        expect(res.reason).toContain('HTTP 502');
    });

    it('reports not-run when there is no LLM service at all', async () => {
        const res = await createExtensionModelPort({ settings })(messages, { stage: 'rubric' });
        expect(res).toEqual({ status: 'not-run', reason: 'rubric: no LLM service configured' });
    });

    it('reports not-run when the provider returns no text', async () => {
        const llmService = { streamChat: jest.fn().mockResolvedValue({ toolCalls: [] }) };
        const res = await createExtensionModelPort({ llmService, settings })(messages, { stage: 'rubric' });
        expect(res).toEqual({ status: 'not-run', reason: 'rubric: model returned no text' });
    });
});

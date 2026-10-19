import { settingsForStage } from '../../utils/modelTiers.js';
import { BUDGET_ERROR_NAME } from '../../utils/callBudget.js';
import { okResult, notRun } from '../../review-core/modelPort.js';

/**
 * Extension implementation of the review-core ModelPort.
 *
 * Every call goes through `LLMService.streamChat`, so the call budget is
 * enforced at the same choke point as every other pass, and the stage picks its
 * model through `settingsForStage` (light model for LIGHT stages when one is
 * configured). A budget refusal or a provider error becomes `not-run` with a
 * reason: the core reports it, it never sees an exception.
 *
 * @param {Object} args
 * @param {Object} args.llmService - an LLMService (anything with streamChat)
 * @param {Object} args.settings - { provider, model, apiKey, lightModel? }
 * @param {string|null} [args.lightModel] - overrides settings.lightModel
 * @returns {import('../../review-core/modelPort.js').ModelPort}
 */
export function createExtensionModelPort({ llmService, settings = {}, lightModel = null } = {}) {
    return async function complete(messages, { stage, priority } = {}) {
        if (!llmService?.streamChat) return notRun(`${stage}: no LLM service configured`);

        try {
            const resp = await llmService.streamChat(messages, {
                ...settingsForStage({
                    stage,
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    lightModel: lightModel ?? settings.lightModel ?? null,
                }),
                stream: false,
                budgetStage: stage,
                budgetPriority: priority,
            });
            const text = typeof resp === 'string' ? resp : resp?.content;
            if (typeof text !== 'string') return notRun(`${stage}: model returned no text`);
            return okResult(text, resp?.usage);
        } catch (e) {
            if (e?.name === BUDGET_ERROR_NAME) return notRun(`${stage}: LLM call budget exhausted`);
            return notRun(`${stage}: model call failed — ${e?.message || e}`);
        }
    };
}

export default createExtensionModelPort;

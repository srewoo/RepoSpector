/**
 * Settings, API-key validation, and per-finding follow-up handlers, extracted
 * from BackgroundService.
 *
 * These delegate to shared state on the service instance (encryptionService,
 * ragService, github/gitlabService, ensureRagEmbeddingProvider, getStoredSettings,
 * llmService, errorHandler, getErrorMessage), which stay on the class. The
 * FindingFollowupService constructor is injected so this module doesn't import
 * it directly; the lazily-created instance is cached on `svc.findingFollowupService`.
 */

/**
 * @param {object} opts
 * @param {object} opts.svc - the BackgroundService instance
 * @param {Function} opts.FindingFollowupService
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createSettingsHandlers({ svc, FindingFollowupService }) {
    async function handleValidateApiKey(message, sendResponse) {
        try {
            const { apiKey } = message.data || {};

            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            sendResponse({ success: response.ok, valid: response.ok });
        } catch (error) {
            sendResponse({ success: false, valid: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleSaveSettings(message, sendResponse) {
        try {
            const { settings } = message.data || {};

            // Encrypt all sensitive keys before storing
            const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey'];

            for (const key of sensitiveKeys) {
                if (settings[key] && settings[key].trim() !== '') {
                    settings[key] = await svc.encryptionService.encrypt(settings[key]);
                }
            }

            await chrome.storage.local.set({ aiRepoSpectorSettings: settings });

            // Update RAG service API key if apiKey was provided
            if (settings.apiKey) {
                try {
                    const decryptedKey = await svc.encryptionService.decrypt(settings.apiKey);
                    svc.ragService.apiKey = decryptedKey;
                    console.log('RAG service API key updated');
                } catch (error) {
                    console.warn('Failed to decrypt API key for RAG service:', error);
                }
            }

            // Always update platform tokens regardless of LLM API key
            try {
                svc.githubService.token = settings.githubToken ?
                    await svc.encryptionService.decrypt(settings.githubToken) : null;
                svc.gitlabService.token = settings.gitlabToken ?
                    await svc.encryptionService.decrypt(settings.gitlabToken) : null;
                if (settings.githubToken) console.log('GitHub token updated');
                if (settings.gitlabToken) console.log('GitLab token updated');
            } catch (error) {
                console.warn('Failed to decrypt platform tokens:', error);
            }

            // Apply embedding-provider changes immediately so the next index/retrieve
            // uses the right RAGService (rebuilds only if the provider actually changed).
            await svc.ensureRagEmbeddingProvider();

            console.log('Settings saved successfully with encryption');
            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Save settings', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGetSettings(message, sendResponse) {
        try {
            const settings = await svc.getStoredSettings();
            sendResponse({ success: true, data: settings });
        } catch (error) {
            svc.errorHandler.logError('Get settings', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * EXPLAIN_FINDING / SUGGEST_FIX — per-finding follow-up actions. The popup
     * invokes these when the user clicks "Why is this a problem?" or "Suggest
     * fix" on a finding card.
     */
    async function handleFindingFollowup(message, sendResponse, kind) {
        try {
            const { finding, code } = message.data || {};
            if (!finding) {
                sendResponse({ success: false, error: 'finding required' });
                return;
            }
            const settings = await svc.getStoredSettings();
            if (!settings?.apiKey) {
                sendResponse({ success: false, error: 'LLM API key not configured' });
                return;
            }
            if (!svc.findingFollowupService) {
                svc.findingFollowupService = new FindingFollowupService({
                    llmService: svc.llmService,
                });
            }
            const args = {
                finding,
                code,
                settings: {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                },
            };
            const result = kind === 'fix'
                ? await svc.findingFollowupService.suggestFix(args)
                : await svc.findingFollowupService.explain(args);
            sendResponse({ success: true, data: result });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        VALIDATE_API_KEY: handleValidateApiKey,
        SAVE_SETTINGS: handleSaveSettings,
        GET_SETTINGS: handleGetSettings,
        EXPLAIN_FINDING: (m, send) => handleFindingFollowup(m, send, 'explain'),
        SUGGEST_FIX: (m, send) => handleFindingFollowup(m, send, 'fix'),
    };
}

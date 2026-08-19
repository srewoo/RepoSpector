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
import { ModelCatalogService } from '../../services/ModelCatalogService.js';
import { setGitLabHosts, setGitHubHosts, hostOf } from '../../utils/gitHosts.js';

/**
 * Split a user-entered host setting into a list.
 *
 * Accepts a single host, a comma/newline separated list, or an array — the
 * settings field is free text and people paste whole MR URLs into it.
 */
export function parseHostList(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Ask Chrome for access to the user's own GitLab and/or GitHub Enterprise
 * instances.
 *
 * Self-hosted hostnames cannot be listed in the manifest at publish time, so
 * they are `optional_host_permissions` granted at runtime. Also registers the
 * content script for the hosts, which is what puts the review overlay on the
 * MR/PR page — without it the extension works only from the popup.
 *
 * Best-effort by design: a rejected prompt must not fail the settings save.
 * The API path still works through the service worker once permission is
 * granted, and if it is not, the user simply sees the existing error.
 *
 * @param {string|string[]|{gitlabHosts?:string|string[], githubHosts?:string|string[]}} input
 *        A bare string or array is read as the GitLab list, which is how this
 *        was called before GHE support.
 */
export async function ensureHostAccess(input) {
    const spec = (typeof input === 'string' || Array.isArray(input))
        ? { gitlabHosts: input }
        : (input || {});

    // The public instances are in the manifest already; requesting them at
    // runtime would prompt the user for access they have had all along.
    const PUBLIC = new Set(['gitlab.com', 'github.com', 'www.github.com']);
    const hosts = [
        ...parseHostList(spec.gitlabHosts),
        ...parseHostList(spec.githubHosts),
    ].map(hostOf).filter(h => h && !PUBLIC.has(h));

    const unique = [...new Set(hosts)];

    // Empty list ONLY: the user explicitly cleared every host, so this is the
    // one path where tearing down any previous registration is unconditional
    // and safe — there is nothing left it could apply to. "Not found" is the
    // normal case when nothing was registered yet, so it is swallowed.
    //
    // This must NOT run for a non-empty list before the permission check
    // below: if the user is adding a host alongside one already granted and
    // working, and rejects the combined prompt, unregistering here first
    // would tear down the previously-working registration for no reason —
    // the rejection changes nothing about hosts already granted.
    if (unique.length === 0) {
        try {
            await chrome.scripting.unregisterContentScripts({ ids: ['repospector-selfhosted'] });
        } catch (e) {
            // no previous registration — expected on first save
        }
        return { granted: false, hosts: [] };
    }

    const origins = unique.map(h => `https://${h}/*`);

    let granted = false;
    try {
        granted = await chrome.permissions.contains({ origins });
        if (!granted) granted = await chrome.permissions.request({ origins });
    } catch (e) {
        console.warn('Host permission request failed:', e?.message);
        return { granted: false, hosts: unique };
    }
    if (!granted) return { granted: false, hosts: unique };

    // Content script for the granted hosts. Re-registering an existing id
    // throws, so unregister first and ignore "not found".
    try {
        await chrome.scripting.unregisterContentScripts({ ids: ['repospector-selfhosted'] }).catch(() => {});
        await chrome.scripting.registerContentScripts([{
            id: 'repospector-selfhosted',
            matches: origins,
            js: ['assets/content.js'],
            runAt: 'document_idle',
            allFrames: false,
        }]);
        console.log(`🔧 Content script registered for ${unique.join(', ')}`);
    } catch (e) {
        console.warn('Could not register content script for self-hosted host:', e?.message);
    }

    return { granted: true, hosts: unique };
}

export function createSettingsHandlers({ svc, FindingFollowupService }) {
    async function handleFetchModels(message, sendResponse) {
        try {
            const { provider, apiKey } = message.data || {};
            let key = apiKey;
            // If the popup didn't pass a fresh key (existing key is masked), fall back
            // to the stored, decrypted key for that provider.
            if ((!key || !key.trim()) && provider !== 'local') {
                const stored = await svc.getStoredSettings();
                const field = {
                    openai: 'apiKey', anthropic: 'anthropicApiKey', google: 'googleApiKey',
                    groq: 'groqApiKey', mistral: 'mistralApiKey'
                }[provider];
                key = field ? stored?.[field] : '';
            }
            const models = await ModelCatalogService.fetchModels(provider, key);
            sendResponse({ success: true, models });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

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
            const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'jiraToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey'];

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

            // Self-hosted GitLab and GitHub Enterprise instances. Applied
            // immediately so the very next review recognises a URL on the
            // user's own host instead of falling through to the wrong forge's
            // API (or, for GHE, being unrecognised entirely — see gitHosts.js).
            try {
                setGitLabHosts(parseHostList(settings.gitlabHosts ?? settings.gitlabHost));
                setGitHubHosts(parseHostList(settings.githubEnterpriseHosts));
                await ensureHostAccess({
                    gitlabHosts: settings.gitlabHosts ?? settings.gitlabHost,
                    githubHosts: settings.githubEnterpriseHosts,
                });
            } catch (error) {
                console.warn('Could not apply host settings:', error?.message);
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
        FETCH_MODELS: handleFetchModels,
        SAVE_SETTINGS: handleSaveSettings,
        GET_SETTINGS: handleGetSettings,
        EXPLAIN_FINDING: (m, send) => handleFindingFollowup(m, send, 'explain'),
        SUGGEST_FIX: (m, send) => handleFindingFollowup(m, send, 'fix'),
    };
}

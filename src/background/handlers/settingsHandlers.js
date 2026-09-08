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
import { LLMService } from '../../services/LLMService.js';
import { DEFAULT_BEDROCK_REGION, LLM_PROVIDERS } from '../../utils/constants.js';
import { resolveModel } from '../../utils/modelResolver.js';
import { isReasoningModel } from '../../utils/modelCapabilities.js';
import { providerNeedsKey } from '../../utils/providerCapabilities.js';
import {
    PROBE_STATE,
    keyProven,
    classifyProbeFailure,
    describeProbeSuccess,
} from '../../utils/apiKeyProbe.js';
import { setGitLabHosts, setGitHubHosts, hostOf, githubApiBase, gitlabApiBase } from '../../utils/gitHosts.js';
import { GIT_PLATFORM, classifyGitTokenProbe } from '../../utils/gitTokenProbe.js';

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
/**
 * Grant access to the Bedrock endpoints for one region.
 *
 * Requested at runtime rather than declared in the manifest because Chrome match
 * patterns allow `*` only as the WHOLE leading host component:
 * `bedrock-runtime.*.amazonaws.com` is rejected as malformed, and the only legal
 * wildcard — `*.amazonaws.com` — would grant every AWS service on the account's
 * behalf. These are the two exact origins Bedrock actually needs, and because
 * they are built from the configured region this also works for regions that did
 * not exist when this shipped (the region field is free text by design).
 *
 * @param {string} region
 * @returns {Promise<{granted:boolean, origins:string[]}>}
 */
export async function ensureBedrockHostAccess(region) {
    const clean = String(region || '').trim();
    // A region is part of the hostname, so a malformed one would produce a
    // malformed origin — the very error this function exists to avoid.
    if (!/^[a-z0-9-]+$/.test(clean)) {
        return { granted: false, origins: [], reason: `Invalid AWS region "${region}"` };
    }

    const origins = [
        `https://bedrock-runtime.${clean}.amazonaws.com/*`,
        `https://bedrock.${clean}.amazonaws.com/*`,
    ];

    try {
        let granted = await chrome.permissions.contains({ origins });
        if (!granted) granted = await chrome.permissions.request({ origins });
        return { granted, origins };
    } catch (e) {
        console.warn('Bedrock host permission request failed:', e?.message);
        return { granted: false, origins, reason: e?.message };
    }
}

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
    /**
     * The credential for `provider`, preferring what the popup just typed and
     * falling back to storage.
     *
     * The fallback is what makes both "Refresh models" and "Test key" work on a
     * masked field: the popup never receives the stored secret back, so it sends
     * an empty string, and a handler that trusted that would report a
     * perfectly-good saved key as missing.
     */
    async function resolveCredential(provider, { apiKey, bedrock } = {}) {
        if (provider === 'bedrock') {
            const stored = await svc.getStoredSettings();
            return {
                accessKeyId: bedrock?.accessKeyId || stored?.bedrockAccessKeyId || '',
                secretAccessKey: bedrock?.secretAccessKey || stored?.bedrockSecretKey || '',
                sessionToken: bedrock?.sessionToken || stored?.bedrockSessionToken || '',
                region: bedrock?.region || stored?.bedrockRegion || DEFAULT_BEDROCK_REGION,
            };
        }
        if (apiKey && apiKey.trim()) return apiKey;
        // Any keyless provider (Ollama, Chrome built-in AI) has no credential
        // to resolve — checking the general predicate rather than hardcoding
        // 'local' is what makes this correct for chrome-ai too.
        if (!providerNeedsKey(provider)) return '';

        const stored = await svc.getStoredSettings();
        const field = {
            openai: 'apiKey', anthropic: 'anthropicApiKey', google: 'googleApiKey',
            groq: 'groqApiKey', mistral: 'mistralApiKey'
        }[provider];
        // Fall back to `apiKey` for anything not in that map, and for a mapped
        // provider whose dedicated field was never written. The popup stores
        // the ACTIVE provider's key in `apiKey` — the per-provider fields are
        // legacy — so a provider absent from the map (OpenRouter, NVIDIA)
        // otherwise got an empty string and failed with "API key required"
        // while a perfectly good key sat in storage.
        return (field && stored?.[field]) || stored?.apiKey || '';
    }

    /**
     * Send the smallest real request the review would send, and report what
     * came back.
     *
     * Deliberately NOT a `/models` listing (see utils/apiKeyProbe.js) and
     * deliberately NOT on `svc.llmService`: that instance carries whatever call
     * budget the last review left on it, and a diagnostic that can be refused
     * by an exhausted budget is a diagnostic that fails exactly when the user
     * most needs it. A fresh instance is unmetered by construction.
     */
    async function handleValidateApiKey(message, sendResponse) {
        const { provider, model, apiKey, bedrock } = message.data || {};
        try {
            if (!provider) throw new Error('No provider selected.');

            // Resolve the model FIRST: a malformed or unselected model is a
            // settings problem, and probing with it would report a model error
            // as if the key were at fault.
            const resolved = resolveModel(model, {
                explicitProvider: provider,
                context: 'the API key test',
            });

            const credential = await resolveCredential(provider, { apiKey, bedrock });
            const hasCredential = provider === 'bedrock'
                ? !!(credential.accessKeyId && credential.secretAccessKey)
                : !providerNeedsKey(provider) || !!String(credential || '').trim();
            if (!hasCredential) {
                sendResponse({
                    success: true,
                    state: PROBE_STATE.KEY_INVALID,
                    keyProven: false,
                    message: provider === 'bedrock'
                        ? 'Enter an Access Key ID and Secret Access Key first.'
                        : 'Enter an API key first.',
                });
                return;
            }

            const probe = new LLMService();
            // One attempt. The default three retries with backoff would make a
            // rate-limited or unreachable provider take ~30s to report what it
            // already knew on the first response, and a rejected key is not a
            // transient condition worth replaying.
            probe.maxRetries = 0;

            if (provider === LLM_PROVIDERS.LOCAL) {
                // Ollama has no key to validate. The diagnostic that matters is
                // whether the local server is reachable and has the selected
                // model pulled — checkOllamaStatus answers both in one probe.
                // Pass the raw `local:`-prefixed model id: matchesOllamaModel
                // (inside the probe) strips the prefix itself.
                const status = await probe.checkOllamaStatus(model);
                sendResponse({
                    success: true,
                    verdict: status.verdict,
                    message: status.message,
                    fix: status.fix,
                });
                return;
            }

            if (provider === 'bedrock') {
                const access = await ensureBedrockHostAccess(credential.region);
                if (!access.granted) {
                    sendResponse({
                        success: true,
                        state: PROBE_STATE.UNREACHABLE,
                        keyProven: false,
                        message: `RepoSpector needs permission to reach ${access.origins.join(' and ')}. `
                            + 'Save your settings again and accept the browser prompt.',
                    });
                    return;
                }
                probe.setBedrockCredentials(credential);
            }

            // A reasoning model spends the cap on thinking before it emits a
            // single visible token, so 16 would come back empty every time.
            // That still proves the key, but "empty reply" reads as a partial
            // success for a call that worked perfectly. 256 output tokens costs
            // a fraction of a cent on any of these models.
            const maxTokens = isReasoningModel(resolved.modelIdentifier) ? 256 : 16;

            const startedAt = Date.now();
            const result = await probe.callLLM(
                {
                    model: resolved.modelIdentifier,
                    messages: [{ role: 'user', content: 'Reply with OK.' }],
                    // Named `max_tokens` for every provider; the OpenAI adapter
                    // renames it for the models that require the newer form.
                    max_tokens: maxTokens,
                },
                provider === 'bedrock' ? undefined : credential,
                { timeout: 20000, cachePrompt: false },
            );
            const latencyMs = Date.now() - startedAt;

            sendResponse({
                success: true,
                state: PROBE_STATE.OK,
                keyProven: true,
                model: resolved.modelIdentifier,
                latencyMs,
                message: describeProbeSuccess({
                    provider,
                    model: resolved.modelId,
                    latencyMs,
                    content: result?.content,
                }),
            });
        } catch (error) {
            const verdict = classifyProbeFailure(error, { provider, model });
            // `success` is about the handler, not the key: the probe ran and
            // produced a verdict, so the popup renders the verdict rather than
            // a generic "request failed".
            sendResponse({
                success: true,
                state: verdict.state,
                keyProven: keyProven(verdict.state),
                status: verdict.status,
                message: verdict.message,
            });
        }
    }

    /**
     * Onboarding probe: "is Ollama reachable at all", asked before any model
     * has been selected. Deliberately does NOT call resolveModel — a fresh
     * install has no model chosen, and resolveModel throws on that, which
     * would make the welcome panel report Ollama unavailable when it is
     * running fine. Passing `model || null` through to checkOllamaStatus is
     * already well-defined: classifyOllamaProbe skips the model-presence
     * check when selectedModel is null and answers only "did the server
     * respond".
     */
    async function handleProbeOllama(message, sendResponse) {
        try {
            const { model } = message.data || {};
            const probe = new LLMService();
            probe.maxRetries = 0;
            const status = await probe.checkOllamaStatus(model || null);
            sendResponse({
                success: true,
                verdict: status.verdict,
                message: status.message,
                fix: status.fix,
            });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleFetchModels(message, sendResponse) {
        try {
            const { provider, apiKey, bedrock } = message.data || {};

            // Bedrock's credential is four values, not one string. Fields the
            // popup left blank (a masked secret it never received) are filled
            // from stored settings, so "Refresh models" works without
            // re-typing the secret every time.
            if (provider === 'bedrock') {
                const stored = await svc.getStoredSettings();
                const creds = {
                    accessKeyId: bedrock?.accessKeyId || stored?.bedrockAccessKeyId || '',
                    secretAccessKey: bedrock?.secretAccessKey || stored?.bedrockSecretKey || '',
                    sessionToken: bedrock?.sessionToken || stored?.bedrockSessionToken || '',
                    region: bedrock?.region || stored?.bedrockRegion || DEFAULT_BEDROCK_REGION,
                };
                // Without the host permission the fetch fails as an opaque
                // "Failed to fetch", which reads as a network problem rather
                // than a permission the user can grant.
                const access = await ensureBedrockHostAccess(creds.region);
                if (!access.granted) {
                    sendResponse({
                        success: false,
                        error: `RepoSpector needs permission to reach ${access.origins.join(' and ')}. `
                            + 'Save your settings again and accept the browser prompt.',
                    });
                    return;
                }

                const bedrockModels = await ModelCatalogService.fetchModels(provider, creds);
                sendResponse({
                    success: true,
                    models: bedrockModels,
                    // The dropdown says "loaded live" or "built-in list" on the
                    // strength of this — claiming a live read that did not happen
                    // is how a stale catalogue looks authoritative.
                    isFallback: !!bedrockModels.isFallback,
                    fallbackReason: bedrockModels.fallbackReason || null,
                    region: creds.region,
                });
                return;
            }

            // Same resolution as the key test: typed key first, stored key
            // second, so a masked field still lists models.
            const key = await resolveCredential(provider, { apiKey });
            const models = await ModelCatalogService.fetchModels(provider, key);
            sendResponse({
                success: true,
                models,
                // Carried for every provider, not just Bedrock: OpenRouter and
                // NVIDIA fall back to a static list the same way, and the
                // dropdown's "loaded live" caption is only honest if it knows.
                isFallback: !!models.isFallback,
                fallbackReason: models.fallbackReason || null,
            });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleSaveSettings(message, sendResponse) {
        try {
            const { settings } = message.data || {};
            // Non-fatal: the settings still save. Returned so the UI can say why
            // Bedrock will not work rather than letting the first review fail
            // with an unexplained network error.
            let bedrockHostWarning = null;

            // Encrypt all sensitive keys before storing
            // Must stay in step with the decrypt list in getStoredSettings: a key
            // saved plaintext but read as ciphertext fails to decrypt, and the
            // self-healing read path then WIPES it. `bedrockAccessKeyId` is
            // deliberately absent — an identifier, not a secret.
            const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'jiraToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey', 'bedrockSecretKey', 'bedrockSessionToken'];

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

            // Bedrock's endpoints are region-scoped and cannot be declared in the
            // manifest (see ensureBedrockHostAccess), so access is requested here
            // — on the same user gesture that saved the settings.
            if (settings.provider === 'bedrock' && settings.bedrockAccessKeyId) {
                try {
                    const result = await ensureBedrockHostAccess(
                        settings.bedrockRegion || DEFAULT_BEDROCK_REGION
                    );
                    if (!result.granted) {
                        console.warn(
                            `Bedrock host access not granted for ${result.origins.join(', ')}`
                            + `${result.reason ? ` (${result.reason})` : ''}`
                        );
                        bedrockHostWarning =
                            'RepoSpector needs permission to reach the AWS Bedrock endpoints for '
                            + `region "${settings.bedrockRegion || DEFAULT_BEDROCK_REGION}". `
                            + 'Save again and accept the browser prompt, or reviews will fail '
                            + 'with a network error.';
                    }
                } catch (error) {
                    console.warn('Could not request Bedrock host access:', error?.message);
                }
            }

            // Apply embedding-provider changes immediately so the next index/retrieve
            // uses the right RAGService (rebuilds only if the provider actually changed).
            await svc.ensureRagEmbeddingProvider();

            console.log('Settings saved successfully with encryption');
            // Key omitted when there is nothing to warn about, so the response
            // for every non-Bedrock save stays exactly what it was.
            sendResponse({ success: true, ...(bedrockHostWarning ? { warning: bedrockHostWarning } : {}) });
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
            // See chatHandlers: keyless providers have no apiKey by design.
            if (providerNeedsKey(settings?.provider) && !settings?.apiKey) {
                sendResponse({
                    success: false,
                    error: `No API key configured for ${settings?.provider || 'this provider'}. `
                        + 'Add one in Settings, or switch to a keyless provider — Ollama or '
                        + 'Chrome built-in AI.',
                });
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

    /**
     * Test a git-platform token by making the smallest authenticated call that
     * platform offers, then classifying the outcome.
     *
     * Runs here rather than in the popup for the same reason every other
     * provider call does: the service worker holds the host permissions and
     * keeps credential-bearing requests out of the page.
     *
     * Deliberately does NOT reach for stored settings — it tests exactly what
     * is typed into the form, so a user can verify a token before saving it.
     */
    async function handleTestGitToken(message, sendResponse) {
        const { platform, token, baseUrl, email } = message.data || {};
        try {
            if (!platform) throw new Error('No platform specified.');

            const request = buildGitTokenRequest({ platform, token, baseUrl, email });
            if (request.error) {
                sendResponse({
                    success: true,
                    state: PROBE_STATE.KEY_INVALID,
                    keyProven: false,
                    message: request.error,
                });
                return;
            }

            let status = null;
            let networkError = null;
            let identity = null;
            let scopeHeader = null;
            let rateLimitRemaining = null;

            try {
                const response = await fetch(request.url, { method: 'GET', headers: request.headers });
                status = response.status;
                scopeHeader = response.headers.get('x-oauth-scopes');
                rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
                if (response.ok) {
                    // Best-effort: a verdict must not depend on the body parsing,
                    // so a malformed success still reports the token as working.
                    try {
                        const body = await response.json();
                        identity = body?.login || body?.username || body?.displayName
                            || body?.name || body?.emailAddress || null;
                    } catch {
                        identity = null;
                    }
                }
            } catch (error) {
                networkError = error?.message || String(error);
            }

            const verdict = classifyGitTokenProbe({
                platform, status, networkError, identity, scopeHeader, rateLimitRemaining,
            });
            sendResponse({ success: true, ...verdict });
        } catch (error) {
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * URL and headers for one platform's identity endpoint.
     *
     * Returns `{ error }` instead of throwing for a missing field, because a
     * blank token is a form problem the user should read in the verdict box,
     * not an exception.
     */
    function buildGitTokenRequest({ platform, token, baseUrl, email }) {
        const trimmedToken = String(token || '').trim();

        if (platform === GIT_PLATFORM.GITHUB) {
            if (!trimmedToken) return { error: 'Enter a GitHub token first.' };
            // Honours a GitHub Enterprise host when one is configured, so the
            // test hits the same API the review would.
            return {
                url: `${githubApiBase(baseUrl)}/user`,
                headers: {
                    Authorization: `Bearer ${trimmedToken}`,
                    Accept: 'application/vnd.github+json',
                },
            };
        }

        if (platform === GIT_PLATFORM.GITLAB) {
            if (!trimmedToken) return { error: 'Enter a GitLab token first.' };
            return {
                url: `${gitlabApiBase(baseUrl)}/user`,
                headers: { 'PRIVATE-TOKEN': trimmedToken },
            };
        }

        if (platform === GIT_PLATFORM.JIRA) {
            const site = String(baseUrl || '').trim().replace(/\/+$/, '');
            const account = String(email || '').trim();
            if (!site || !account || !trimmedToken) {
                return { error: 'Jira needs all three: site URL, email, and API token.' };
            }
            return {
                url: `${site}/rest/api/3/myself`,
                headers: {
                    Authorization: `Basic ${btoa(`${account}:${trimmedToken}`)}`,
                    Accept: 'application/json',
                },
            };
        }

        return { error: `Unknown platform "${platform}".` };
    }

    return {
        VALIDATE_API_KEY: handleValidateApiKey,
        FETCH_MODELS: handleFetchModels,
        PROBE_OLLAMA: handleProbeOllama,
        TEST_GIT_TOKEN: handleTestGitToken,
        SAVE_SETTINGS: handleSaveSettings,
        GET_SETTINGS: handleGetSettings,
        EXPLAIN_FINDING: (m, send) => handleFindingFollowup(m, send, 'explain'),
        SUGGEST_FIX: (m, send) => handleFindingFollowup(m, send, 'fix'),
    };
}

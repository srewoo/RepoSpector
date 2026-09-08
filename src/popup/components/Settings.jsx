import React, { useState, useEffect } from 'react';
import { Save, Eye, EyeOff, Key, AlertCircle, CheckCircle, Cpu, Sun, Moon, Palette, Github, GitBranch, Shield, BarChart2, Trash2, Loader2 } from 'lucide-react';
import { KeyTestVerdict } from './settings/KeyTestVerdict.jsx';
import { GitTokenTestButton } from './settings/GitTokenTestButton.jsx';
import { Button } from './ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Collapsible } from './ui/Collapsible';
import { useTheme } from '../contexts/ThemeContext';
import {
    DEFAULT_MAX_AI_CALLS,
    MIN_MAX_AI_CALLS,
    MAX_MAX_AI_CALLS,
    normalizeMaxAiCalls,
} from '../../utils/callBudget.js';
import { PROBE_STATE } from '../../utils/apiKeyProbe.js';
import {
    BEDROCK_FALLBACK_MODELS,
    BEDROCK_REGIONS,
    DEFAULT_BEDROCK_REGION,
    OPENROUTER_FALLBACK_MODELS,
    NVIDIA_FALLBACK_MODELS,
} from '../../utils/constants.js';
import { providerNeedsKey } from '../../utils/providerCapabilities.js';
import { panelForProvider } from './settings/providerPanelRegistry.js';
import { getProviderLabel } from './settings/providerLabels.js';

/**
 * First hostname from a comma/space separated free-text host field, as a URL.
 *
 * The host settings accept a list and people paste whole URLs into them, so the
 * git-token test needs one canonical origin to probe. Empty returns null, which
 * makes the API-base helpers fall back to the public instance.
 */
function parseFirstHost(value) {
    const first = String(value || '').split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean)[0];
    if (!first) return null;
    return /^https?:\/\//i.test(first) ? first : `https://${first}`;
}

const LLM_PROVIDERS = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    GROQ: 'groq',
    MISTRAL: 'mistral',
    OPENROUTER: 'openrouter',
    NVIDIA: 'nvidia',
    BEDROCK: 'bedrock',
    LOCAL: 'local',  // Ollama
    CHROME_AI: 'chrome-ai'  // Chrome built-in AI (Gemini Nano), no key
};

/**
 * Fallback list, used ONLY when the live catalogue cannot be fetched.
 *
 * Deliberately not labelled "Latest" any more. This list is hand-maintained and
 * therefore always drifting — it claimed GPT-4.1 was the latest flagship while
 * the same key could list gpt-5.6 — and a stale label that asserts recency is
 * worse than no label, because it reads as current. The live list from
 * `ModelCatalogService` is the source of truth; this is the offline stand-in.
 */
const AVAILABLE_MODELS = {
    [LLM_PROVIDERS.OPENAI]: [
        { id: 'openai:gpt-5', name: 'GPT-5', recommended: true },
        { id: 'openai:gpt-4.1', name: 'GPT-4.1' },
        { id: 'openai:gpt-4.1-mini', name: 'GPT-4.1 Mini (Fast & Cheap)' },
        { id: 'openai:o1-mini', name: 'o1-mini (Reasoning)' }
    ],
    [LLM_PROVIDERS.ANTHROPIC]: [
        { id: 'anthropic:claude-sonnet-4', name: 'Claude Sonnet 4 (Latest)', recommended: true },
        { id: 'anthropic:claude-3.5-haiku', name: 'Claude 3.5 Haiku (Fast)' },
        { id: 'anthropic:claude-opus-4', name: 'Claude Opus 4 (Most Capable)' }
    ],
    [LLM_PROVIDERS.GOOGLE]: [
        { id: 'google:gemini-2.0-flash', name: 'Gemini 2.0 Flash (Latest)', recommended: true },
        { id: 'google:gemini-2.0-pro', name: 'Gemini 2.0 Pro (Premium)' },
        { id: 'google:gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite (Fastest)' }
    ],
    [LLM_PROVIDERS.GROQ]: [
        { id: 'groq:llama-3.3-70b', name: 'Llama 3.3 70B (Ultra Fast)', recommended: true },
        { id: 'groq:deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 70B (Reasoning)' },
        { id: 'groq:mixtral-8x7b', name: 'Mixtral 8x7B (Balanced)' }
    ],
    [LLM_PROVIDERS.MISTRAL]: [
        { id: 'mistral:mistral-large', name: 'Mistral Large 2 (Latest)', recommended: true },
        { id: 'mistral:codestral', name: 'Codestral (Code-focused)' },
        { id: 'mistral:mistral-small', name: 'Mistral Small (Fast)' }
    ],
    // Both gateways serve hundreds of models that change weekly, so hand-listing
    // them here would be stale on arrival. These mirror the shared fallback
    // constants; the live list fetched with the user's key is what users actually
    // pick from.
    [LLM_PROVIDERS.OPENROUTER]: OPENROUTER_FALLBACK_MODELS.map((m, i) => ({
        id: `openrouter:${m.id}`,
        name: m.name,
        recommended: i === 0,
    })),
    [LLM_PROVIDERS.NVIDIA]: NVIDIA_FALLBACK_MODELS.map((m, i) => ({
        id: `nvidia:${m.id}`,
        name: m.name,
        recommended: i === 0,
    })),
    // Mirrors BEDROCK_FALLBACK_MODELS so the dropdown is populated before any
    // signed listing call has run. See constants.js for why the id prefix
    // (global./us./eu./bare) is the part that decides whether a model works.
    [LLM_PROVIDERS.BEDROCK]: BEDROCK_FALLBACK_MODELS.map((m, i) => ({
        id: `bedrock:${m.id}`,
        name: m.name,
        recommended: i === 0,
    })),
    [LLM_PROVIDERS.LOCAL]: [
        // A code model is the right default for a code-review tool, and it is
        // also the smaller download: llama3.3 is a general chat model in the
        // tens of GB at common quantisations.
        { id: 'local:qwen2.5-coder', name: 'Qwen 2.5 Coder', recommended: true },
        { id: 'local:deepseek-coder-v2', name: 'DeepSeek Coder V2' },
        { id: 'local:llama3.3', name: 'Llama 3.3 (general purpose)' }
    ],
    [LLM_PROVIDERS.CHROME_AI]: [
        { id: 'chrome-ai:nano', name: 'Gemini Nano (on-device)', recommended: true }
    ]
};

export function Settings({ onClose }) {
    const { theme, toggleTheme } = useTheme();
    const [apiKey, setApiKey] = useState('');
    const [provider, setProvider] = useState(LLM_PROVIDERS.OPENAI);
    const [model, setModel] = useState('openai:gpt-4.1-mini');
    // Models fetched live from the provider (null = use the static fallback list).
    const [dynamicModels, setDynamicModels] = useState(null);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState(null);
    // Embedding provider for repository indexing / RAG (independent of the chat LLM).
    // 'local' = bundled Transformers.js model (free, private, offline); 'openai' = OpenAI API.
    const [embeddingProvider, setEmbeddingProvider] = useState('local');
    // Separate from `apiKey`, which follows the CHAT provider. Gemini embeddings
    // can be selected while the chat provider is something else entirely, so the
    // Google key needs its own home.
    const [googleApiKey, setGoogleApiKey] = useState('');
    const [showGoogleKey, setShowGoogleKey] = useState(false);
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [error, setError] = useState(null);
    const [hasExistingKey, setHasExistingKey] = useState(false);
    // AWS Bedrock credentials. Four fields rather than one key: Bedrock signs
    // each request with IAM credentials instead of sending a bearer token, and
    // the region is part of both the endpoint and the signature.
    const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState('');
    const [bedrockSecretKey, setBedrockSecretKey] = useState('');
    const [bedrockSessionToken, setBedrockSessionToken] = useState('');
    const [bedrockRegion, setBedrockRegion] = useState(DEFAULT_BEDROCK_REGION);
    // True when the region is one the built-in list does not carry, so the field
    // becomes free text. Set on load as well as by the "Other…" option — a saved
    // region absent from the list must not be silently replaced by a listed one.
    const [bedrockRegionCustom, setBedrockRegionCustom] = useState(false);
    // True when the model list shown is the built-in one because live listing
    // failed. Distinguishing the two is the whole point of showing a count.
    const [modelsAreFallback, setModelsAreFallback] = useState(false);

    // Result of the last "Test key" press: null = never run.
    // `{ state, keyProven, message }` straight from the background probe — the
    // verdict is composed there so the popup and any other caller cannot drift
    // into wording it differently.
    const [keyTest, setKeyTest] = useState(null);
    const [keyTesting, setKeyTesting] = useState(false);

    /**
     * Per-platform verdicts for the git token tests, keyed by platform.
     * Separate from `keyTest` (the LLM provider probe) because both can be on
     * screen at once and one must not overwrite the other's result.
     */
    const [gitTokenTest, setGitTokenTest] = useState({});
    const [gitTokenTesting, setGitTokenTesting] = useState(null);

    // Git platform tokens (for RAG indexing)
    const [githubToken, setGithubToken] = useState('');
    const [gitlabToken, setGitlabToken] = useState('');
    // Jira is optional and independent of the git host: teams on GitHub or
    // GitLab commonly keep the requirement (and its acceptance criteria) in Jira.
    const [jiraBaseUrl, setJiraBaseUrl] = useState('');
    const [jiraEmail, setJiraEmail] = useState('');
    const [jiraToken, setJiraToken] = useState('');
    const [showJiraToken, setShowJiraToken] = useState(false);
    const [gitlabHosts, setGitlabHosts] = useState('');
    const [githubEnterpriseHosts, setGithubEnterpriseHosts] = useState('');
    const [showGithubToken, setShowGithubToken] = useState(false);
    const [showGitlabToken, setShowGitlabToken] = useState(false);

    // Review quality settings
    const [severityThreshold, setSeverityThreshold] = useState('medium');
    // Cost ceiling. Held as a STRING so the field can be empty while typing —
    // storing a number here forces a 0 the moment the user clears it, and 0 means
    // "unlimited", i.e. backspacing the field would silently remove the cap.
    const [maxAiCalls, setMaxAiCalls] = useState(String(DEFAULT_MAX_AI_CALLS));
    const [enableDynamicContext, setEnableDynamicContext] = useState(true);
    const [filterMode, setFilterMode] = useState('added');
    const [failLevel, setFailLevel] = useState('high');
    const [lightModel, setLightModel] = useState('');
    const [persistentSummary, setPersistentSummary] = useState(true);
    const [groupFindings, setGroupFindings] = useState(true);

    // Analysis feature toggles
    const [enableOSV, setEnableOSV] = useState(true);
    const [enableEOL, setEnableEOL] = useState(true);
    const [enableAdaptiveLearning, setEnableAdaptiveLearning] = useState(true);
    const [enablePRComments, setEnablePRComments] = useState(false);

    // Write feature toggles (features that write data to GitHub/GitLab)
    const [enableAutoPostReview, setEnableAutoPostReview] = useState(false);
    const [autoReviewOnLoad, setAutoReviewOnLoad] = useState(false);
    const [autoIndexOnOpen, setAutoIndexOnOpen] = useState(true);
    const [enableUpdatePRDescription, setEnableUpdatePRDescription] = useState(false);
    const [enablePostInlineComments, setEnablePostInlineComments] = useState(false);

    // Orchestrated review pipeline (skip rules + chunking + assigned-hunks
    // normalization). Now the default — this toggle is the opt-OUT. While it was
    // opt-in the common path skipped hunk normalization entirely.
    const [enableOrchestratedReview, setEnableOrchestratedReview] = useState(true);

    // Telemetry (#16a)
    const [enableTelemetry, setEnableTelemetry] = useState(false);
    const [telemetrySummary, setTelemetrySummary] = useState(null);
    const [telemetryLoading, setTelemetryLoading] = useState(false);
    const [telemetryClearing, setTelemetryClearing] = useState(false);

    // Load settings from background service (with decryption)
    useEffect(() => {
        const loadSettings = async () => {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_SETTINGS'
                });

                if (response.success && response.data) {
                    const settings = response.data;
                    setApiKey(settings.apiKey || '');
                    setHasExistingKey(!!settings.apiKey);
                    setBedrockAccessKeyId(settings.bedrockAccessKeyId || '');
                    setBedrockSecretKey(settings.bedrockSecretKey || '');
                    setBedrockSessionToken(settings.bedrockSessionToken || '');
                    const savedRegion = settings.bedrockRegion || DEFAULT_BEDROCK_REGION;
                    setBedrockRegion(savedRegion);
                    setBedrockRegionCustom(!BEDROCK_REGIONS.includes(savedRegion));
                    setGithubToken(settings.githubToken || '');
                    setGitlabToken(settings.gitlabToken || '');
                    setJiraBaseUrl(settings.jiraBaseUrl || '');
                    setJiraEmail(settings.jiraEmail || '');
                    setJiraToken(settings.jiraToken || '');
                    setGitlabHosts(
                        Array.isArray(settings.gitlabHosts)
                            ? settings.gitlabHosts.join(', ')
                            : (settings.gitlabHosts || settings.gitlabHost || '')
                    );
                    setGithubEnterpriseHosts(
                        Array.isArray(settings.githubEnterpriseHosts)
                            ? settings.githubEnterpriseHosts.join(', ')
                            : (settings.githubEnterpriseHosts || '')
                    );
                    setEmbeddingProvider(
                        ['openai', 'gemini'].includes(settings.embeddingProvider)
                            ? settings.embeddingProvider
                            : 'local'
                    );
                    setGoogleApiKey(settings.googleApiKey || '');

                    // Load review quality settings
                    if (settings.reviewSettings) {
                        setSeverityThreshold(settings.reviewSettings.severityThreshold || 'medium');
                        setMaxAiCalls(String(
                            settings.reviewSettings.maxAiCalls ?? DEFAULT_MAX_AI_CALLS
                        ));
                        setEnableDynamicContext(settings.reviewSettings.enableDynamicContext !== false);
                        setFilterMode(settings.reviewSettings.filterMode || 'added');
                        setFailLevel(settings.reviewSettings.failLevel || 'high');
                        setLightModel(settings.reviewSettings.lightModel || '');
                        setPersistentSummary(settings.reviewSettings.persistentSummary !== false);
                        setGroupFindings(settings.reviewSettings.groupRelatedFindings !== false);
                        setEnableOSV(settings.reviewSettings.enableOSV !== false);
                        setEnableEOL(settings.reviewSettings.enableEOL !== false);
                        setEnableAdaptiveLearning(settings.reviewSettings.enableAdaptiveLearning !== false);
                        setEnablePRComments(settings.reviewSettings.enablePRComments === true);

                        // Load write feature toggles
                        setEnableAutoPostReview(settings.reviewSettings.enableAutoPostReview === true);
                        setAutoReviewOnLoad(settings.reviewSettings.autoReviewOnLoad === true);
                        setAutoIndexOnOpen(settings.reviewSettings.autoIndexOnOpen !== false);
                        setEnableUpdatePRDescription(settings.reviewSettings.enableUpdatePRDescription === true);
                        setEnablePostInlineComments(settings.reviewSettings.enablePostInlineComments === true);
                        setEnableOrchestratedReview(settings.reviewSettings.orchestratedReview !== false);
                    }

                    // Load model selection
                    if (settings.model && typeof settings.model === 'string') {
                        // Check if model has provider prefix (e.g., "openai:gpt-4.1")
                        if (settings.model.includes(':')) {
                            const providerFromModel = settings.model.split(':')[0];
                            if (Object.values(LLM_PROVIDERS).includes(providerFromModel)) {
                                setProvider(providerFromModel);
                                setModel(settings.model);
                            } else {
                                // Unknown provider, use default
                                setProvider(LLM_PROVIDERS.OPENAI);
                                setModel('openai:gpt-4.1');
                            }
                        } else {
                            // Legacy model without provider prefix, default to OpenAI
                            setProvider(LLM_PROVIDERS.OPENAI);
                            setModel('openai:gpt-4.1');
                        }
                    }
                } else {
                    console.warn('Failed to load settings:', response.error);
                }
            } catch (error) {
                console.error('Failed to load settings:', error);
                setError('Failed to load settings. Please try refreshing.');
            } finally {
                setSettingsLoaded(true);
            }
        };

        loadSettings();
    }, []);

    // Fetch the live model list from the provider's API (uses the entered key, or
    // the stored key if the field is masked). Falls back to the static list on error.
    const refreshModels = async () => {
        setModelsLoading(true);
        setModelsError(null);
        try {
            const resp = await chrome.runtime.sendMessage({
                type: 'FETCH_MODELS',
                data: {
                    provider,
                    apiKey,
                    // Sent only for Bedrock; the background fills any field left
                    // blank from stored settings, so a masked secret still works.
                    ...(provider === LLM_PROVIDERS.BEDROCK
                        ? {
                            bedrock: {
                                accessKeyId: bedrockAccessKeyId,
                                secretAccessKey: bedrockSecretKey,
                                sessionToken: bedrockSessionToken,
                                region: bedrockRegion,
                            },
                        }
                        : {}),
                }
            });
            if (resp?.success && Array.isArray(resp.models) && resp.models.length) {
                setDynamicModels(resp.models);
                setModelsAreFallback(!!resp.isFallback);
                // A fallback list is not an error, but it is not a live read
                // either — say which one the user is looking at.
                if (resp.isFallback && resp.fallbackReason) {
                    setModelsError(resp.fallbackReason);
                }
            } else {
                setModelsError(resp?.error || 'Could not load models');
            }
        } catch (e) {
            setModelsError(e?.message || 'Could not load models');
        } finally {
            setModelsLoading(false);
        }
    };

    /**
     * Send one minimal request to the selected provider + model and report what
     * came back.
     *
     * The verdict is more than a boolean because the failures worth telling
     * apart are not all about the key: an out-of-credit account and a retired
     * model id both authenticate fine, and calling either "invalid key" sends
     * the user to regenerate a key that was never the problem. See
     * utils/apiKeyProbe.js.
     */
    /**
     * Test one git-platform credential against its identity endpoint.
     *
     * Sends what is currently typed, not what is stored, so a token can be
     * verified before saving. The background handler owns the request because
     * that is where the host permissions live.
     */
    const testGitToken = async (platform) => {
        setGitTokenTesting(platform);
        setGitTokenTest((prev) => ({ ...prev, [platform]: null }));
        try {
            const data = { platform };
            if (platform === 'github') {
                data.token = githubToken;
                // First configured GHE host, so the test hits the same API the
                // review will. Blank falls back to github.com.
                data.baseUrl = parseFirstHost(githubEnterpriseHosts);
            } else if (platform === 'gitlab') {
                data.token = gitlabToken;
                data.baseUrl = parseFirstHost(gitlabHosts);
            } else if (platform === 'jira') {
                data.baseUrl = jiraBaseUrl;
                data.email = jiraEmail;
                data.token = jiraToken;
            }

            const resp = await chrome.runtime.sendMessage({ type: 'TEST_GIT_TOKEN', data });
            setGitTokenTest((prev) => ({
                ...prev,
                [platform]: resp?.success
                    ? resp
                    : { state: 'unreachable', keyProven: false, message: resp?.error || 'The test could not run.' },
            }));
        } catch (e) {
            setGitTokenTest((prev) => ({
                ...prev,
                [platform]: { state: 'unreachable', keyProven: false, message: e?.message || 'The test could not run.' },
            }));
        } finally {
            setGitTokenTesting(null);
        }
    };

    const testApiKey = async () => {
        setKeyTesting(true);
        setKeyTest(null);
        try {
            const resp = await chrome.runtime.sendMessage({
                type: 'VALIDATE_API_KEY',
                data: {
                    provider,
                    model,
                    // Same contract as FETCH_MODELS: send what is typed, and the
                    // background fills a blank field from stored settings, so a
                    // masked key still tests.
                    apiKey,
                    ...(provider === LLM_PROVIDERS.BEDROCK
                        ? {
                            bedrock: {
                                accessKeyId: bedrockAccessKeyId,
                                secretAccessKey: bedrockSecretKey,
                                sessionToken: bedrockSessionToken,
                                region: bedrockRegion,
                            },
                        }
                        : {}),
                },
            });
            setKeyTest(resp?.success
                ? resp
                : {
                    state: PROBE_STATE.UNKNOWN,
                    keyProven: false,
                    message: resp?.error || 'The test could not run.',
                });
        } catch (e) {
            setKeyTest({
                state: PROBE_STATE.UNKNOWN,
                keyProven: false,
                message: e?.message || 'The test could not run.',
            });
        } finally {
            setKeyTesting(false);
        }
    };

    // A verdict describes one provider + model + key. Any of the three changing
    // makes it stale, and a stale green tick is worse than no tick — it is the
    // one thing a user would rely on without re-checking.
    useEffect(() => {
        setKeyTest(null);
    }, [provider, model, apiKey, bedrockAccessKeyId, bedrockSecretKey, bedrockRegion]);

    // When the provider changes, drop the previous provider's live list and try to
    // fetch the new one if we have (or stored) a key. Local (Ollama) needs no key.
    useEffect(() => {
        if (!settingsLoaded) return;
        setDynamicModels(null);
        setModelsError(null);
        setModelsAreFallback(false);
        if (provider === LLM_PROVIDERS.BEDROCK) {
            if (bedrockAccessKeyId && bedrockSecretKey) refreshModels();
        } else if (!providerNeedsKey(provider) || apiKey || hasExistingKey) {
            refreshModels();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, settingsLoaded]);

    // Load telemetry enabled state + summary
    useEffect(() => {
        const loadTelemetry = async () => {
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'GET_TELEMETRY' });
                if (resp?.success && resp.data) {
                    setEnableTelemetry(resp.data.enabled || false);
                    setTelemetrySummary(resp.data.summary || null);
                }
            } catch (_e) { /* telemetry is optional */ }
        };
        loadTelemetry();
    }, []);

    const handleToggleTelemetry = async (next) => {
        setEnableTelemetry(next);
        try {
            await chrome.runtime.sendMessage({ type: 'SET_TELEMETRY_ENABLED', data: { enabled: next } });
            if (next) {
                const resp = await chrome.runtime.sendMessage({ type: 'GET_TELEMETRY' });
                if (resp?.success) setTelemetrySummary(resp.data?.summary || null);
            }
        } catch (_e) { /* ignore */ }
    };

    const handleClearTelemetry = async () => {
        setTelemetryClearing(true);
        try {
            await chrome.runtime.sendMessage({ type: 'CLEAR_TELEMETRY' });
            setTelemetrySummary(null);
        } catch (_e) { /* ignore */ }
        setTelemetryClearing(false);
    };

    const handleRefreshTelemetry = async () => {
        setTelemetryLoading(true);
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'GET_TELEMETRY' });
            if (resp?.success) setTelemetrySummary(resp.data?.summary || null);
        } catch (_e) { /* ignore */ }
        setTelemetryLoading(false);
    };

    // Reset the model ONLY when the user actually switches to a different provider —
    // i.e. the current model's provider prefix no longer matches. This must never
    // clobber a saved model on initial load (that was the bug where gpt-5 reverted to
    // gpt-4.1: settingsLoaded flipping true re-ran this and overwrote the loaded model).
    useEffect(() => {
        if (!settingsLoaded) return;
        if (model && model.startsWith(`${provider}:`)) return; // model already valid for provider
        const list = (dynamicModels && dynamicModels.length) ? dynamicModels : (AVAILABLE_MODELS[provider] || []);
        if (list.length > 0) {
            const recommended = list.find(m => m.recommended);
            setModel(recommended ? recommended.id : list[0].id);
        }
    }, [provider, settingsLoaded, dynamicModels, model]);

    const handleSave = async () => {
        setIsLoading(true);
        setIsSaved(false);
        setError(null);

        try {
            // Validate API key (not required for local/Ollama)
            if (providerNeedsKey(provider) && (!apiKey || apiKey.trim() === '')) {
                throw new Error('API key is required');
            }

            // Send to background service for encryption and storage
            const response = await chrome.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                data: {
                    settings: {
                        apiKey: apiKey,
                        model: model,
                        provider: provider,
                        embeddingProvider: embeddingProvider,
                        googleApiKey: googleApiKey,
                        bedrockAccessKeyId: bedrockAccessKeyId.trim(),
                        bedrockSecretKey: bedrockSecretKey.trim(),
                        bedrockSessionToken: bedrockSessionToken.trim(),
                        bedrockRegion: bedrockRegion,
                        githubToken: githubToken,
                        gitlabToken: gitlabToken,
                        jiraBaseUrl: jiraBaseUrl.trim().replace(/\/+$/, ''),
                        jiraEmail: jiraEmail.trim(),
                        jiraToken: jiraToken,
                        gitlabHosts: gitlabHosts,
                        githubEnterpriseHosts: githubEnterpriseHosts,
                        reviewSettings: {
                            severityThreshold: severityThreshold,
                            // Normalized on the way in, not on the way out: the
                            // stored value is then always a usable ceiling, so a
                            // typo cannot reach the pipeline as "unlimited".
                            maxAiCalls: normalizeMaxAiCalls(maxAiCalls),
                            enableDynamicContext: enableDynamicContext,
                            filterMode: filterMode,
                            failLevel: failLevel,
                            // Empty means "no tiering" — every stage uses the one
                            // model, which is the conservative default.
                            lightModel: lightModel.trim() || null,
                            persistentSummary: persistentSummary,
                            groupRelatedFindings: groupFindings,
                            enableOSV: enableOSV,
                            enableEOL: enableEOL,
                            enableAdaptiveLearning: enableAdaptiveLearning,
                            enablePRComments: enablePRComments,
                            enableAutoPostReview: enableAutoPostReview,
                            autoReviewOnLoad: autoReviewOnLoad,
                            autoIndexOnOpen: autoIndexOnOpen,
                            enableUpdatePRDescription: enableUpdatePRDescription,
                            enablePostInlineComments: enablePostInlineComments,
                            orchestratedReview: enableOrchestratedReview
                        }
                    }
                }
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to save settings');
            }

            setIsLoading(false);
            setIsSaved(true);

            // The save succeeded but something will not work — currently only
            // the Bedrock host permission. Shown instead of auto-closing, since
            // a panel that closes itself would take the warning with it.
            if (response.warning) {
                setError(response.warning);
                return;
            }

            // Auto-close after success
            setTimeout(() => {
                onClose();
            }, 1500);
        } catch (error) {
            console.error('Save failed:', error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Failed to save settings. Please try again.';
            setError(errMsg);
            setIsLoading(false);
        }
    };

    // Bedrock authenticates with an IAM signature, so it shows a credentials
    // block instead of the single API-key field every other provider uses.
    const isBedrock = provider === LLM_PROVIDERS.BEDROCK;

    return (
        <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-text">Settings</h2>
                <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            </div>

            {/* Error Display */}
            {error && (
                <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            )}

            {/* API Key Status Indicator */}
            {hasExistingKey && (
                <div className="flex items-center gap-2 px-3 py-2 bg-success/10 border border-success/20 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span className="text-sm text-success">API key configured</span>
                </div>
            )}

            {/* Appearance Section */}
            <Collapsible title="Appearance" icon={Palette} defaultOpen={true}>
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <p className="text-sm font-medium text-text">Theme</p>
                        <p className="text-xs text-textMuted">
                            Switch between dark and light mode
                        </p>
                    </div>
                    <button
                        onClick={toggleTheme}
                        className="relative flex items-center gap-2 h-10 px-4 bg-surfaceHighlight border border-border rounded-lg hover:bg-surfaceHighlight/80 transition-colors"
                    >
                        {theme === 'dark' ? (
                            <>
                                <Moon className="w-4 h-4 text-primary" />
                                <span className="text-sm">Dark</span>
                            </>
                        ) : (
                            <>
                                <Sun className="w-4 h-4 text-warning" />
                                <span className="text-sm">Light</span>
                            </>
                        )}
                    </button>
                </div>
            </Collapsible>

            {/* AI Configuration Section */}
            <Collapsible
                title="AI Configuration"
                icon={Cpu}
                defaultOpen={true}
                badge={getProviderLabel(provider)}
            >
                <div className="space-y-4">
                    {/* LLM Provider */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text">Provider</label>
                        <select
                            value={provider}
                            onChange={(e) => setProvider(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            {Object.values(LLM_PROVIDERS).map(prov => (
                                <option key={prov} value={prov}>
                                    {getProviderLabel(prov)}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Model Selection */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-text">Model</label>
                            <button
                                type="button"
                                onClick={refreshModels}
                                disabled={modelsLoading}
                                className="text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                                title="Fetch the latest models from your provider using your key"
                            >
                                {modelsLoading ? 'Loading…' : '↻ Refresh models'}
                            </button>
                        </div>
                        {(() => {
                            const staticList = AVAILABLE_MODELS[provider] || [];
                            const live = (dynamicModels && dynamicModels.length) ? dynamicModels : staticList;
                            // Keep the currently-selected model selectable even if the
                            // live list doesn't include it (e.g. a pinned/older model).
                            const options = live.some(m => m.id === model)
                                ? live
                                : [{ id: model, name: (model.split(':')[1] || model) + ' (current)' }, ...live];
                            return (
                                <select
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
                                    className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                                >
                                    {options.map(m => (
                                        <option key={m.id} value={m.id}>
                                            {m.name} {m.recommended ? '⭐' : ''}
                                        </option>
                                    ))}
                                </select>
                            );
                        })()}
                        <p className="text-xs text-textMuted">
                            {dynamicModels && dynamicModels.length && modelsAreFallback
                                ? `${dynamicModels.length} models from the built-in list — live listing unavailable${modelsError ? ` (${modelsError})` : ''}`
                                : dynamicModels && dynamicModels.length
                                ? `${dynamicModels.length} models loaded live from ${getProviderLabel(provider)}${isBedrock ? ` · ${bedrockRegion}` : ''}`
                                : modelsError
                                    ? `⚠️ Live list unavailable (${modelsError}) — these ${(AVAILABLE_MODELS[provider] || []).length} built-in defaults may be out of date. Your key may support newer models.`
                                    : 'Enter your key, then ↻ Refresh to list the models your key can actually use'}
                        </p>
                    </div>

                    {(() => {
                        const Panel = panelForProvider(provider);
                        return (
                            <Panel
                                provider={provider}
                                apiKey={apiKey}
                                setApiKey={setApiKey}
                                hasExistingKey={hasExistingKey}
                                keyTest={keyTest}
                                keyTesting={keyTesting}
                                testApiKey={testApiKey}
                                refreshModels={refreshModels}
                                model={model}
                                bedrock={{
                                    accessKeyId: bedrockAccessKeyId,
                                    setAccessKeyId: setBedrockAccessKeyId,
                                    secretKey: bedrockSecretKey,
                                    setSecretKey: setBedrockSecretKey,
                                    sessionToken: bedrockSessionToken,
                                    setSessionToken: setBedrockSessionToken,
                                    region: bedrockRegion,
                                    setRegion: setBedrockRegion,
                                    regionCustom: bedrockRegionCustom,
                                    setRegionCustom: setBedrockRegionCustom,
                                }}
                            />
                        );
                    })()}

                    {/* Embedding Provider — used for repository indexing / RAG (separate from the chat model) */}
                    <div className="space-y-2 pt-4 border-t border-border">
                        <label className="text-sm font-medium text-text">Embedding Provider</label>
                        <select
                            value={embeddingProvider}
                            onChange={(e) => setEmbeddingProvider(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            <option value="local">Local — Transformers.js (Free &amp; Private) ⭐</option>
                            <option value="openai">OpenAI (text-embedding-3-small)</option>
                            <option value="gemini">Google Gemini (gemini-embedding-001)</option>
                        </select>
                        {embeddingProvider === 'local' && (
                            <p className="text-xs text-textMuted">
                                Runs the all-MiniLM-L6-v2 model bundled inside the extension — 100% local,
                                works offline and behind firewalls. No API key or network required.
                            </p>
                        )}
                        {embeddingProvider === 'openai' && (
                            <p className="text-xs text-textMuted">
                                Uses the OpenAI Embeddings API. Requires an <span className="text-text">OpenAI</span> API
                                key in the field above. Sends your code to OpenAI for embedding.
                            </p>
                        )}
                        {embeddingProvider === 'gemini' && (
                            <>
                                <p className="text-xs text-textMuted">
                                    Uses the Gemini Embeddings API at 1536 dimensions, matching the OpenAI
                                    option. Sends your code to Google for embedding.
                                </p>
                                {/* Shown only when the chat provider is NOT Google: in that case
                                    the key above is already a Google key, so asking twice for the
                                    same secret invites the two copies to drift. */}
                                {provider !== LLM_PROVIDERS.GOOGLE ? (
                                    <div className="space-y-2 pt-2">
                                        <label className="text-sm font-medium text-text">Google API Key</label>
                                        <div className="relative">
                                            <input
                                                type={showGoogleKey ? 'text' : 'password'}
                                                value={googleApiKey}
                                                onChange={(e) => setGoogleApiKey(e.target.value)}
                                                placeholder="AIza..."
                                                className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowGoogleKey(!showGoogleKey)}
                                                className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                                            >
                                                {showGoogleKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                            </button>
                                        </div>
                                        <p className="text-xs text-textMuted">
                                            Get your key from:{' '}
                                            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                                Google AI Studio
                                            </a>
                                        </p>
                                    </div>
                                ) : (
                                    <p className="text-xs text-textMuted">
                                        Using the <span className="text-text">Google</span> API key from the field above.
                                    </p>
                                )}
                            </>
                        )}
                        <p className="text-xs text-yellow-500">
                            Changing this requires re-indexing your repositories (embedding dimensions differ).
                        </p>
                    </div>
                </div>
            </Collapsible>

            {/* Git Platform Tokens Section */}
            <Collapsible
                title="Git Platform Tokens"
                icon={GitBranch}
                defaultOpen={false}
                badge="Optional"
            >
                <div className="space-y-4">
                    {/* GitHub Token */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">GitHub Token</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Private repos + higher rate limits
                            </span>
                            <GitTokenTestButton platform="github" testing={gitTokenTesting} onTest={testGitToken} />
                        </div>
                        <div className="relative">
                            <input
                                type={showGithubToken ? 'text' : 'password'}
                                value={githubToken}
                                onChange={(e) => setGithubToken(e.target.value)}
                                placeholder="ghp_..."
                                className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                            />
                            <button
                                type="button"
                                onClick={() => setShowGithubToken(!showGithubToken)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                            >
                                {showGithubToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-xs text-textMuted">
                            Get from:{' '}
                            <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitHub Settings
                            </a>
                            {' '}- Use "repo" scope
                        </p>
                        <KeyTestVerdict result={gitTokenTest.github} />
                    </div>

                    {/* GitLab Token */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">GitLab Token</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Private repos
                            </span>
                            <GitTokenTestButton platform="gitlab" testing={gitTokenTesting} onTest={testGitToken} />
                        </div>
                        <div className="relative">
                            <input
                                type={showGitlabToken ? 'text' : 'password'}
                                value={gitlabToken}
                                onChange={(e) => setGitlabToken(e.target.value)}
                                placeholder="glpat-..."
                                className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                            />
                            <button
                                type="button"
                                onClick={() => setShowGitlabToken(!showGitlabToken)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                            >
                                {showGitlabToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-xs text-textMuted">
                            Get from:{' '}
                            <a href="https://gitlab.com/-/profile/personal_access_tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                GitLab Settings
                            </a>
                            {' '}- Use "read_api" scope
                        </p>
                        <KeyTestVerdict result={gitTokenTest.gitlab} />
                    </div>

                    {/* Jira — optional; unlocks acceptance-criteria checking */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">Jira</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Optional
                            </span>
                            <GitTokenTestButton platform="jira" testing={gitTokenTesting} onTest={testGitToken} />
                        </div>
                        <p className="text-xs text-textMuted">
                            When a PR title or branch names a Jira issue, the reviewer reads its
                            acceptance criteria and reports any the diff does not address.
                        </p>
                        <input
                            type="url"
                            value={jiraBaseUrl}
                            onChange={(e) => setJiraBaseUrl(e.target.value)}
                            placeholder="https://your-team.atlassian.net"
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                        />
                        <input
                            type="email"
                            value={jiraEmail}
                            onChange={(e) => setJiraEmail(e.target.value)}
                            placeholder="you@company.com"
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                        />
                        <div className="relative">
                            <input
                                type={showJiraToken ? 'text' : 'password'}
                                value={jiraToken}
                                onChange={(e) => setJiraToken(e.target.value)}
                                placeholder="Jira API token"
                                className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                            />
                            <button
                                type="button"
                                onClick={() => setShowJiraToken(!showJiraToken)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                            >
                                {showJiraToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-xs text-textMuted">
                            Get from:{' '}
                            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Atlassian API tokens
                            </a>
                            {' '}- all three fields are required
                        </p>
                        <KeyTestVerdict result={gitTokenTest.jira} />
                    </div>

                    {/* Self-hosted GitLab. Without this, a URL on an internal
                        instance is not recognised as GitLab at all. */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">Self-hosted GitLab host</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Optional
                            </span>
                        </div>
                        <input
                            type="text"
                            value={gitlabHosts}
                            onChange={(e) => setGitlabHosts(e.target.value)}
                            placeholder="gitlab.mycompany.com"
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                        />
                        <p className="text-xs text-textMuted">
                            Hostname only, or several separated by commas. gitlab.com always works.
                            Saving prompts for permission to read that host.
                        </p>
                    </div>

                    {/* GitHub Enterprise. Unlike GitLab, a GHE host cannot be
                        inferred from a URL's shape, since /pull/<n> is shared
                        with Codeberg and Gitea — it must be registered here. */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-text">GitHub Enterprise host</label>
                            <span className="text-[10px] text-textMuted bg-surfaceHighlight px-1.5 py-0.5 rounded">
                                Optional
                            </span>
                        </div>
                        <input
                            type="text"
                            value={githubEnterpriseHosts}
                            onChange={(e) => setGithubEnterpriseHosts(e.target.value)}
                            placeholder="github.acme.com"
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                        />
                        <p className="text-xs text-textMuted">
                            GitHub Enterprise hostnames, comma-separated (e.g. github.acme.com).
                            Required only if you use GitHub Enterprise: unlike GitLab, an enterprise
                            GitHub host cannot be detected from the URL alone, so it must be
                            registered here. Saving prompts for permission to read that host.
                        </p>
                    </div>
                </div>
            </Collapsible>

            {/* Review Quality Section */}
            <Collapsible
                title="Review Quality"
                icon={Shield}
                defaultOpen={false}
                badge={severityThreshold === 'all' ? 'Show All' : `${severityThreshold}+`}
            >
                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text">Minimum Severity</label>
                        <select
                            value={severityThreshold}
                            onChange={(e) => setSeverityThreshold(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            <option value="all">Show All Findings</option>
                            <option value="low">Low and above</option>
                            <option value="medium">Medium and above</option>
                            <option value="high">High and Critical only</option>
                            <option value="critical">Critical only</option>
                        </select>
                        <p className="text-xs text-textMuted">
                            Filter out low-priority findings to reduce noise
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text" htmlFor="max-ai-calls">
                            Max AI Calls per Review
                        </label>
                        <input
                            id="max-ai-calls"
                            type="number"
                            min={MIN_MAX_AI_CALLS}
                            max={MAX_MAX_AI_CALLS}
                            step={1}
                            value={maxAiCalls}
                            onChange={(e) => setMaxAiCalls(e.target.value)}
                            onBlur={() => setMaxAiCalls(String(normalizeMaxAiCalls(maxAiCalls)))}
                            placeholder={String(DEFAULT_MAX_AI_CALLS)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        />
                        <p className="text-xs text-textMuted">
                            A hard ceiling on how many model calls one review may make. A large PR is
                            split into review units and each surviving finding is verified and scored,
                            so the call count multiplies — this is what stops a single review from
                            costing far more than you expected. When the ceiling is reached the review
                            still completes and tells you which passes it skipped.
                            {' '}<strong>0 means no limit.</strong> Default {DEFAULT_MAX_AI_CALLS}.
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Expand Hunks to Enclosing Function</p>
                            <p className="text-xs text-textMuted">
                                For large files, show each change grown out to the function or class
                                that contains it, instead of pasting the whole file. Cheaper, and it
                                keeps the model&apos;s attention on the changed component.
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableDynamicContext(!enableDynamicContext)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableDynamicContext ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableDynamicContext ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text" htmlFor="filter-mode">
                            Where Findings May Be Reported
                        </label>
                        <select
                            id="filter-mode"
                            value={filterMode}
                            onChange={(e) => setFilterMode(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            <option value="added">Lines this PR added (strictest)</option>
                            <option value="diff_context">Added lines and their diff context</option>
                            <option value="file">Anywhere in the changed files</option>
                            <option value="nofilter">Anywhere (no filtering)</option>
                        </select>
                        <p className="text-xs text-textMuted">
                            A finding outside this scope is not reported. A finding just outside it is
                            moved to the nearest line in scope <em>and says so</em>, rather than being
                            moved silently. Widening this surfaces issues in code you did not touch —
                            useful for an audit, noisy for a review.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text" htmlFor="fail-level">
                            Block the Merge At
                        </label>
                        <select
                            id="fail-level"
                            value={failLevel}
                            onChange={(e) => setFailLevel(e.target.value)}
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        >
                            <option value="none">Never — always comment, never request changes</option>
                            <option value="critical">Critical findings only</option>
                            <option value="high">High and critical (default)</option>
                            <option value="medium">Medium and above</option>
                            <option value="any">Any finding at all</option>
                        </select>
                        <p className="text-xs text-textMuted">
                            Separate from the severity threshold above: that decides what gets
                            <em> reported</em>, this decides what turns the review into
                            &ldquo;changes requested&rdquo;. Previously the two were the same knob, so
                            the only way to stop blocking on a finding was to stop seeing it.
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">One Summary Comment per PR</p>
                            <p className="text-xs text-textMuted">
                                Update the existing review summary instead of adding a new comment each
                                run, so the PR always shows the current review rather than a stack of
                                stale ones. The previous review is kept, collapsed, because replies are
                                attached to it.
                            </p>
                        </div>
                        <button
                            onClick={() => setPersistentSummary(!persistentSummary)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                persistentSummary ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    persistentSummary ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text" htmlFor="light-model">
                            Light Model <span className="text-textMuted font-normal">(optional)</span>
                        </label>
                        <input
                            id="light-model"
                            type="text"
                            value={lightModel}
                            onChange={(e) => setLightModel(e.target.value)}
                            placeholder="e.g. openai:gpt-4.1-mini — leave empty to use one model everywhere"
                            className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                        />
                        <p className="text-xs text-textMuted">
                            A cheaper model for the stages that restate rather than analyse — summary,
                            re-ranking, fix wording, docstrings. The review and verification passes
                            always use your main model. Include the provider prefix
                            (<code>openai:</code>, <code>anthropic:</code>&hellip;) if it differs from
                            your main provider.
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Group Related Findings</p>
                            <p className="text-xs text-textMuted">
                                Collapse similar findings in the same file
                            </p>
                        </div>
                        <button
                            onClick={() => setGroupFindings(!groupFindings)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                groupFindings ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    groupFindings ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Auto-Review on Page Load</p>
                            <p className="text-xs text-textMuted">
                                Automatically run a review when you open a PR/MR page (once per PR). If the repo
                                isn&apos;t indexed yet it is indexed <strong>first</strong>, so the review has full
                                context — on a large repo the first run spends a while on &ldquo;Indexing&rdquo;
                                before it starts reviewing. Off by default — reviews use your BYOK model.
                            </p>
                        </div>
                        <button
                            onClick={() => setAutoReviewOnLoad(!autoReviewOnLoad)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                autoReviewOnLoad ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    autoReviewOnLoad ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Auto-Index Repo on Open</p>
                            <p className="text-xs text-textMuted">
                                When you open a PR/MR whose repo isn&apos;t indexed yet, index it so review context
                                (RAG + code graph) is ready before you ask for a review. On by default. Only applies
                                when Auto-Review is off — with Auto-Review on, the review indexes first itself.
                            </p>
                        </div>
                        <button
                            onClick={() => setAutoIndexOnOpen(!autoIndexOnOpen)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                autoIndexOnOpen ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    autoIndexOnOpen ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            </Collapsible>

            {/* Analysis Features Section */}
            <Collapsible
                title="Analysis Features"
                icon={Shield}
                defaultOpen={false}
                badge={[enableOSV && 'OSV', enableEOL && 'EOL', enableAdaptiveLearning && 'Learning', enablePRComments && 'Comments'].filter(Boolean).join(', ') || 'None'}
            >
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">OSV Vulnerability Scanning</p>
                            <p className="text-xs text-textMuted">
                                Check dependencies against the OSV.dev database
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableOSV(!enableOSV)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableOSV ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableOSV ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">End-of-Life Detection</p>
                            <p className="text-xs text-textMuted">
                                Detect EOL runtimes and frameworks
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableEOL(!enableEOL)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableEOL ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableEOL ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Adaptive Learning</p>
                            <p className="text-xs text-textMuted">
                                Reduce noise by learning from dismissed findings
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableAdaptiveLearning(!enableAdaptiveLearning)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableAdaptiveLearning ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableAdaptiveLearning ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-border">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">
                                Orchestrated Review <span className="text-xs text-textMuted">(default)</span>
                            </p>
                            <p className="text-xs text-textMuted">
                                Skip rules · MR chunking · two-phase review · hunk-scoped findings. Turn off to use the legacy engine.
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableOrchestratedReview(!enableOrchestratedReview)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableOrchestratedReview ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableOrchestratedReview ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>


                    <div className="flex items-center justify-between pt-3 border-t border-border">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Post Comments to PR</p>
                            <p className="text-xs text-textMuted">
                                Allow posting review comments directly on GitHub/GitLab PRs
                            </p>
                            {!enablePRComments && (
                                <p className="text-xs text-yellow-500">
                                    Disabled by default — requires a platform token
                                </p>
                            )}
                        </div>
                        <button
                            onClick={() => setEnablePRComments(!enablePRComments)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enablePRComments ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enablePRComments ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            </Collapsible>

            {/* Write Features Section - Features that write to GitHub/GitLab */}
            <Collapsible
                title="Write Features"
                icon={GitBranch}
                defaultOpen={false}
                badge={[enableAutoPostReview && 'Post Review', enableUpdatePRDescription && 'Update PR', enablePostInlineComments && 'Inline'].filter(Boolean).join(', ') || 'All Disabled'}
            >
                <div className="space-y-1 mb-3">
                    <p className="text-xs text-amber-400 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        These features write data to your Git platform. Enable carefully.
                    </p>
                </div>
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Auto-Post PR Review</p>
                            <p className="text-xs text-textMuted">
                                Automatically post review comments to GitHub/GitLab after analysis
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableAutoPostReview(!enableAutoPostReview)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableAutoPostReview ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableAutoPostReview ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Update PR Description</p>
                            <p className="text-xs text-textMuted">
                                Allow one-click PR description update from generated content
                            </p>
                        </div>
                        <button
                            onClick={() => setEnableUpdatePRDescription(!enableUpdatePRDescription)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableUpdatePRDescription ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableUpdatePRDescription ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Post Inline Comments</p>
                            <p className="text-xs text-textMuted">
                                Post inline code review comments on specific lines
                            </p>
                        </div>
                        <button
                            onClick={() => setEnablePostInlineComments(!enablePostInlineComments)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enablePostInlineComments ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enablePostInlineComments ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            </Collapsible>

            {/* Telemetry Section (#16a) */}
            <Collapsible
                title="Local Telemetry"
                icon={BarChart2}
                defaultOpen={false}
                badge={enableTelemetry ? 'Enabled' : 'Opt-in'}
            >
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-text">Enable Local Telemetry</p>
                            <p className="text-xs text-textMuted">
                                Store review stats locally (never leaves your browser)
                            </p>
                        </div>
                        <button
                            onClick={() => handleToggleTelemetry(!enableTelemetry)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                                enableTelemetry ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white shadow-sm ring-1 ring-black/10 rounded-full transition-transform ${
                                    enableTelemetry ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>

                    {enableTelemetry && (
                        <div className="space-y-3">
                            {telemetrySummary && telemetrySummary.runs > 0 ? (
                                <div className="bg-surface rounded-lg p-3 space-y-2 text-xs">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <p className="text-textMuted">Total Reviews</p>
                                            <p className="font-medium text-text">{telemetrySummary.runs ?? 0}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Total Cost</p>
                                            <p className="font-medium text-text">${(telemetrySummary.costUsd ?? 0).toFixed(4)}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Latency p50</p>
                                            <p className="font-medium text-text">{telemetrySummary.latency?.p50 > 0 ? `${(telemetrySummary.latency.p50 / 1000).toFixed(1)}s` : '—'}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Latency p95</p>
                                            <p className="font-medium text-text">{telemetrySummary.latency?.p95 > 0 ? `${(telemetrySummary.latency.p95 / 1000).toFixed(1)}s` : '—'}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">FP Rate</p>
                                            <p className="font-medium text-text">{(telemetrySummary.findings?.dismissed ?? 0) > 0 ? `${((telemetrySummary.findings.fpRate ?? 0) * 100).toFixed(0)}%` : '—'}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Findings Kept</p>
                                            <p className="font-medium text-text">{telemetrySummary.findings?.kept ?? 0}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Tokens (in / out)</p>
                                            <p className="font-medium text-text">{(telemetrySummary.tokens?.in ?? 0).toLocaleString()} / {(telemetrySummary.tokens?.out ?? 0).toLocaleString()}</p>
                                        </div>
                                        <div>
                                            <p className="text-textMuted">Dismissed</p>
                                            <p className="font-medium text-text">{telemetrySummary.findings?.dismissed ?? 0}</p>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-textMuted">No reviews recorded yet.</p>
                            )}
                            <div className="flex gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleRefreshTelemetry}
                                    isLoading={telemetryLoading}
                                    className="flex-1"
                                >
                                    <BarChart2 className="w-3 h-3 mr-1" />
                                    Refresh Stats
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleClearTelemetry}
                                    isLoading={telemetryClearing}
                                    className="flex-1 text-red-400 hover:text-red-300"
                                >
                                    <Trash2 className="w-3 h-3 mr-1" />
                                    Reset
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </Collapsible>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
                <Button onClick={handleSave} isLoading={isLoading} className="w-full sm:w-auto">
                    <Save className="w-4 h-4 mr-2" />
                    {isSaved ? 'Saved!' : 'Save Settings'}
                </Button>
            </div>
        </div>
    );
}

/**
 * provider → credential panel.
 *
 * Settings.jsx keeps layout, persistence and the provider/model selects, and
 * delegates the credential block. Adding a provider means adding a panel and
 * one line here, not another conditional in a 1795-line component.
 */

import { LLM_PROVIDERS } from '../../../utils/constants.js';
import { ApiKeyProviderPanel } from './ApiKeyProviderPanel.jsx';
import { BedrockPanel } from './BedrockPanel.jsx';
import { OllamaPanel } from './OllamaPanel.jsx';
import { ChromeAIPanel } from './ChromeAIPanel.jsx';

const PANELS = {
    [LLM_PROVIDERS.BEDROCK]: BedrockPanel,
    [LLM_PROVIDERS.LOCAL]: OllamaPanel,
    [LLM_PROVIDERS.CHROME_AI]: ChromeAIPanel,
};

/** Every other provider authenticates with a single API key. */
export function panelForProvider(provider) {
    return PANELS[provider] || ApiKeyProviderPanel;
}

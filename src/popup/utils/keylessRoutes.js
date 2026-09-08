/**
 * Rank the ways this user can get a first result.
 *
 * Ordered by time-to-first-result, not by quality: the welcome panel's one job
 * is to get someone to a working result, and the fastest route is rarely the
 * best one. Quality is stated in the labels so the ordering does not mislead.
 *
 * Pure. The panel renders whatever this returns.
 */

import { CHROME_AI_AVAILABILITY } from '../../utils/chromeAI.js';
import { OLLAMA_VERDICT } from '../../utils/ollamaProbe.js';

export const ROUTE_IDS = Object.freeze({
    OLLAMA: 'ollama',
    CHROME_AI: 'chrome-ai',
    API_KEY: 'api-key',
    MCP: 'mcp',
});

const TIER = Object.freeze({
    READY: 'Ready now',
    SETUP: 'A few minutes',
    UNAVAILABLE: 'Not available here',
});

/** Lower sorts first. Ready routes first, then setup, then unavailable. */
const TIER_RANK = { [TIER.READY]: 0, [TIER.SETUP]: 1, [TIER.UNAVAILABLE]: 2 };

function ollamaRow(verdict) {
    if (verdict === OLLAMA_VERDICT.OK) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.READY, label: 'Ollama — running, no key', detail: 'Best quality of the keyless options.', action: 'Use it', enabled: true };
    }
    if (verdict === OLLAMA_VERDICT.CORS_BLOCKED) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — needs one setting', detail: 'Running, but not yet set to allow this extension’s origin.', action: 'Fix it', enabled: true };
    }
    if (verdict === OLLAMA_VERDICT.MODEL_MISSING) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — needs a model', detail: 'Running, but the selected model is not pulled yet.', action: 'Fix it', enabled: true };
    }
    return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — no key, best quality', detail: 'Runs on your machine. About five minutes to set up.', action: 'Set up', enabled: true };
}

function chromeAIRow(state, reason) {
    if (state === CHROME_AI_AVAILABILITY.AVAILABLE) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.READY, label: 'Chrome built-in AI — nothing to install', detail: 'On-device. Good for summaries; too small for full PR review.', action: 'Use it', enabled: true };
    }
    if (state === CHROME_AI_AVAILABILITY.DOWNLOADABLE) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.SETUP, label: 'Chrome built-in AI — one download', detail: 'No key needed. One-time model download of about 2 GB.', action: 'Download', enabled: true };
    }
    if (state === CHROME_AI_AVAILABILITY.DOWNLOADING) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.SETUP, label: 'Chrome built-in AI — downloading', detail: 'The model is still downloading.', action: 'View progress', enabled: true };
    }
    return { id: ROUTE_IDS.CHROME_AI, tier: TIER.UNAVAILABLE, label: 'Chrome built-in AI', detail: reason || 'Not available in this browser.', action: '', enabled: false };
}

export function rankKeylessRoutes({
    chromeAI = CHROME_AI_AVAILABILITY.UNAVAILABLE,
    chromeAIReason = '',
    ollama = OLLAMA_VERDICT.NOT_RUNNING,
    hasKey = false,
    mcpPublished = false,
} = {}) {
    const rows = [
        ollamaRow(ollama),
        chromeAIRow(chromeAI, chromeAIReason),
        {
            id: ROUTE_IDS.API_KEY,
            tier: hasKey ? TIER.READY : TIER.SETUP,
            label: hasKey ? 'Your API key — configured' : 'Bring your own API key',
            detail: 'Full power: multi-pass review across large diffs.',
            action: hasKey ? 'Use it' : 'Add key',
            enabled: true,
        },
    ];

    if (mcpPublished) {
        rows.push({
            id: ROUTE_IDS.MCP,
            tier: TIER.SETUP,
            label: 'Use from Claude or Codex',
            detail: 'Your Claude subscription does the reasoning; RepoSpector supplies repo context.',
            action: 'Copy config',
            enabled: true,
        });
    }

    // Stable sort by tier; within a tier, declaration order stands — which is
    // what puts a working Ollama above an available on-device model.
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => (TIER_RANK[a.row.tier] - TIER_RANK[b.row.tier]) || (a.index - b.index))
        .map(({ row }) => row);
}

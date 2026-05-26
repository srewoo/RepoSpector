/**
 * FindingFollowupService — per-finding "explain" + "suggest fix" actions.
 *
 * Turns each Finding from read-only text into a starting point for a short
 * conversation. Two actions:
 *
 *   explain(finding, code) → plain-English why this matters + when it
 *                            actually bites + how to verify
 *   suggestFix(finding, code) → concrete code diff or replacement snippet
 *
 * Both share the same LLM provider/model the rest of the review uses, and
 * route through LLMService so retries/caching/keepalive all apply.
 *
 * Findings without a known file/line still work — the LLM just gets less
 * context and produces a shorter answer.
 */

const EXPLAIN_SYSTEM_PROMPT = `You are a senior engineer helping a code reviewer understand a finding.

Given a finding and the surrounding code, explain:
1. Why this is a real problem (or downgrade it if it's actually fine).
2. The smallest concrete scenario where it would bite in production.
3. How the reviewer can verify whether this PR actually has the problem.

Be specific, no hedging. 5 sentences max. If the finding is wrong, say so.`;

const FIX_SYSTEM_PROMPT = `You are a senior engineer proposing a minimal fix for a code review finding.

Given a finding and the surrounding code, return:
1. A short rationale (1 sentence).
2. A unified-diff-formatted patch with @@ hunks, OR an inline replacement if a full diff isn't possible.
3. Any caveats — tests to add, callers to update, edge cases.

Be minimal — change as little as possible. No prose outside the structure.`;

export class FindingFollowupService {
    /**
     * @param {object} deps
     * @param {object} deps.llmService - extension LLMService instance
     */
    constructor({ llmService } = {}) {
        if (!llmService) throw new Error('FindingFollowupService requires llmService');
        this.llmService = llmService;
        // In-memory cache so flipping between explain/fix on the same
        // finding twice doesn't double-bill the API.
        this._cache = new Map();
    }

    /**
     * @param {object} args
     * @param {object} args.finding   - canonical Finding shape
     * @param {string} [args.code]    - the surrounding code (optional)
     * @param {object} args.settings  - { provider, model, apiKey }
     * @returns {Promise<{ content: string, tokensIn?: number, tokensOut?: number }>}
     */
    async explain(args) {
        return this._run('explain', EXPLAIN_SYSTEM_PROMPT, args);
    }

    async suggestFix(args) {
        return this._run('fix', FIX_SYSTEM_PROMPT, args);
    }

    async _run(kind, systemPrompt, { finding, code, settings, _bypassCache } = {}) {
        if (!finding) throw new Error('finding required');
        if (!settings?.apiKey) throw new Error('settings.apiKey required');

        const cacheKey = `${kind}::${finding.id ?? `${finding.file}:${finding.line}`}::${(finding.suggestion ?? '').slice(0, 80)}`;
        if (!_bypassCache && this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey);
        }

        const userPrompt = buildUserPrompt(finding, code);
        const response = await this.llmService.streamChat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            {
                provider: settings.provider,
                model: settings.model,
                apiKey: settings.apiKey,
                stream: false,
                temperature: 0.1,
                max_tokens: 600,
            },
        );

        const result = {
            content: response?.content ?? String(response ?? ''),
            tokensIn: response?.usage?.input ?? 0,
            tokensOut: response?.usage?.output ?? 0,
        };
        this._cache.set(cacheKey, result);
        return result;
    }

    clearCache() {
        this._cache.clear();
    }
}

function buildUserPrompt(finding, code) {
    const parts = [
        `Finding:`,
        `  Severity: ${finding.severity}`,
        `  Category: ${finding.category}`,
        `  File: ${finding.file ?? '(unknown)'}`,
        `  Line: ${finding.line ?? '(unknown)'}`,
        `  Rule: ${finding.rule ?? '(none)'}`,
        `  Title: ${finding.title ?? '(none)'}`,
        '',
        `Suggestion:`,
        finding.suggestion ?? '(empty)',
    ];
    if (finding.evidence) {
        parts.push('', 'Evidence:', '```', finding.evidence, '```');
    }
    if (code) {
        parts.push('', 'Surrounding code:', '```', code.slice(0, 4000), '```');
    }
    return parts.join('\n');
}

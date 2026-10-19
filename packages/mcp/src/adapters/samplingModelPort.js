import crypto from 'node:crypto';
import { requestCompletion, samplingStatus } from '../sampling.js';
import { okResult, notRun, delegated } from '../../../../src/review-core/modelPort.js';

/**
 * ModelPort over MCP sampling — the CLIENT's model, never a key in this process.
 *
 * Three outcomes, matching the shared contract:
 *   ok        the client ran the completion;
 *   not-run   the client advertises sampling but refused or returned nothing;
 *   delegated the client offers no sampling at all. The request is handed back
 *             to the caller so `review_pr` / `submit_review_findings` can put it
 *             in front of the host agent, which answers it itself. Asking is not
 *             answering: a delegated request leaves the finding unscored until
 *             the host's answer arrives.
 */

export const DEFAULT_MAX_TOKENS = 2048;

/** A message body as text: a string, or the `[{text, cache?}]` parts the lens prompt builder returns. */
export function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
    }
    return String(content ?? '');
}

/**
 * Deterministic, so re-running the same review asks the host the same question
 * under the same id — a host answering an id from an earlier bundle still lands.
 */
export function requestIdFor(stage, messages) {
    const digest = crypto.createHash('sha1')
        .update(JSON.stringify([stage, messages]))
        .digest('hex')
        .slice(0, 16);
    return `${stage}:${digest}`;
}

/**
 * MCP sampling takes one user message plus an optional system prompt. A scorer
 * retry is a conversation (user, assistant, user), so turns after the first
 * are rendered as a labelled transcript inside that one message.
 */
function toSamplingRequest(list) {
    const system = list.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = list.filter((m) => m.role !== 'system');
    const prompt = turns.length === 1
        ? turns[0].content
        : turns.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    return { system: system || null, prompt };
}

/** @returns {import('../../../../src/review-core/modelPort.js').ModelPort} */
export function createSamplingModelPort({ server = null, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
    return async function complete(messages, opts = {}) {
        const stage = String(opts.stage ?? 'unknown');
        const list = (Array.isArray(messages) ? messages : []).map((m) => ({
            role: String(m?.role ?? 'user'),
            content: contentText(m?.content),
        }));

        if (!samplingStatus(server).available) {
            return delegated({
                id: opts.requestId ?? requestIdFor(stage, list),
                stage,
                messages: list,
                schema: opts.schema ?? null,
            });
        }

        const { system, prompt } = toSamplingRequest(list);
        const completion = await requestCompletion(server, {
            system,
            prompt,
            maxTokens: opts.maxTokens ?? maxTokens,
        });
        return completion.text
            ? okResult(completion.text)
            : notRun(completion.reason || 'the client returned no completion');
    };
}

export default { createSamplingModelPort, requestIdFor, contentText, DEFAULT_MAX_TOKENS };

/**
 * RepoExplorerService — let the model ask for repository context instead of
 * guessing what it will need.
 *
 * Every other context channel in this pipeline is PUSH: the handler decides
 * what to retrieve — RAG chunks, graph summaries, N full files — before the
 * model has seen the diff, and whatever it picked is all the model ever gets.
 * That ordering is the real limitation, not the size of the index. The repo is
 * indexed completely; the reviewer just cannot ask it anything.
 *
 * This is the PULL side. The model reads the diff, notices that a changed
 * function is called somewhere it cannot see, and asks — mid-review — for that
 * file. Three tools, all served from the local index with no network:
 *
 *   read_file(path)        the file's indexed source
 *   find_callers(symbol)   who calls it, from the code graph
 *   search_repo(query)     semantic search over the embeddings
 *
 * ── When it runs ──
 *
 * On by default for REASONING models, off otherwise (see
 * `modelCapabilities.shouldExplore`). The cost is extra round trips on a review
 * the user is waiting for, paid on their own API key — but a user who selected
 * a reasoning model has already accepted that trade, and those models are the
 * ones that use tools well: they decide what to look up and stop when they have
 * it, instead of calling every tool once because it exists.
 *
 * Below that bar the old default holds, because the case for spending someone
 * else's budget is weaker: the eval harness has not yet shown exploration helps,
 * and it found misses concentrating in LARGE files, which reads as attention
 * dilution — an argument that more context can hurt.
 *
 * `reviewSettings.repoExploration` (or `options.repoExploration`) set to `true`
 * or `false` overrides the model-based default in either direction.
 */

import { LLMService } from './LLMService.js';
import {
    buildAssistantEcho,
    buildToolResultMessages,
} from '../utils/toolProtocol.js';
import { numberLines } from '../utils/chunkLines.js';

/** Tool definitions in the OpenAI shape; LLMService translates for Anthropic. */
export const EXPLORER_TOOLS = Object.freeze([
    {
        type: 'function',
        function: {
            name: 'read_file',
            description:
                'Read a file from the repository index. Use when the diff calls, extends, or '
                + 'depends on code you cannot see, and the answer to "does this change break it?" '
                + 'requires the actual source. Returns indexed content, which may be partial for '
                + 'very large files.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Repository-relative path, e.g. "src/api/upload.js".',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_callers',
            description:
                'List the functions that call a symbol, resolved from the code graph. Use when the '
                + 'diff changes a signature, return shape, or behavioural contract and you need to '
                + 'know who depends on it. Returns names and file paths; follow up with read_file '
                + 'to see one.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: {
                        type: 'string',
                        description: 'Function, method, or class name.',
                    },
                },
                required: ['symbol'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_repo',
            description:
                'Semantic search across the repository. Use to find how a pattern is handled '
                + 'elsewhere, or whether the change contradicts an existing convention. Prefer '
                + 'read_file or find_callers when you already know the path or symbol.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to look for, in natural language.' },
                },
                required: ['query'],
            },
        },
    },
]);

/** Truncation applied to every tool result, so one call cannot flood the loop. */
const MAX_RESULT_CHARS = 6000;

export class RepoExplorerService {
    /**
     * @param {Object} deps
     * @param {Object} deps.llmService
     * @param {Object} deps.ragService - provides vectorStore + retrieveContext
     * @param {Object} deps.codeGraphPipeline
     */
    constructor({ llmService, ragService, codeGraphPipeline } = {}) {
        this.llmService = llmService;
        this.ragService = ragService;
        this.pipeline = codeGraphPipeline;
    }

    /** Is exploration possible for this provider and this repo's index? */
    canExplore(provider) {
        return !!this.llmService
            && !!this.ragService?.vectorStore
            && LLMService.supportsTools(provider);
    }

    /**
     * Execute one tool call against the local index.
     *
     * Never throws: a tool that fails returns an explanatory string, which the
     * model can read and route around. Throwing would abort a review over a
     * missing file the model merely guessed at.
     *
     * @param {{name: string, args: Object}} call
     * @param {string} repoId
     * @returns {Promise<string>}
     */
    async executeTool(call, repoId) {
        try {
            switch (call.name) {
                case 'read_file':
                    return await this._readFile(call.args?.path, repoId);
                case 'find_callers':
                    return this._findCallers(call.args?.symbol);
                case 'search_repo':
                    return await this._searchRepo(call.args?.query, repoId);
                default:
                    return `Error: unknown tool "${call.name}".`;
            }
        } catch (e) {
            return `Error running ${call.name}: ${e?.message || 'unknown failure'}`;
        }
    }

    async _readFile(path, repoId) {
        if (!path) return 'Error: read_file requires a "path".';
        const store = this.ragService?.vectorStore;
        if (!store?.getChunksForFiles) return 'Error: repository index unavailable.';

        const map = await store.getChunksForFiles(repoId, [path]);
        const chunks = map?.get(path);
        if (!chunks?.length) {
            return `No indexed content for "${path}". The path may be wrong, or the file may be `
                + 'excluded from indexing (binary, vendored, or over the size limit).';
        }
        // Number each chunk from its own recorded start line. Chunks overlap,
        // so a single stitched body would have drifting line numbers — but each
        // chunk individually knows where it begins, so numbering them
        // separately is both correct and more useful than one blob.
        const numbered = chunks.map(c => (
            Number.isInteger(c.startLine)
                ? numberLines(c.content, c.startLine)
                : c.content
        ));
        const anyLines = chunks.some(c => Number.isInteger(c.startLine));
        const note = anyLines
            ? 'line numbers are real; sections may overlap slightly'
            : 'this index predates line tracking — do not cite line numbers from it';
        return `File: ${path} (indexed content; ${note})\n\n${truncate(numbered.join('\n\n'))}`;
    }

    _findCallers(symbol) {
        if (!symbol) return 'Error: find_callers requires a "symbol".';
        const refs = this.pipeline?.getCallerRefs?.(symbol, 12) || [];
        if (refs.length === 0) {
            return `No callers of "${symbol}" in the code graph. It may be new, external, `
                + 'called dynamically, or named differently at the call site.';
        }
        const lines = refs.map(r =>
            `- ${r.name} (${r.filePath}${r.startLine ? `, near line ${r.startLine}` : ''})`
            + ` [${Math.round((r.confidence || 0) * 100)}% confidence]`);
        return `Callers of "${symbol}" (${refs.length}):\n${lines.join('\n')}`;
    }

    async _searchRepo(query, repoId) {
        if (!query) return 'Error: search_repo requires a "query".';
        const results = await this.ragService.retrieveContext(repoId, query, 6, {
            formatOutput: false,
        });
        const list = Array.isArray(results) ? results : results?.results;
        if (!Array.isArray(list) || list.length === 0) return `No matches for "${query}".`;

        return truncate(list.slice(0, 6).map(r => {
            const path = r.filePath || r.file || 'unknown';
            const content = String(r.content || r.text || '').slice(0, 1200);
            return `--- ${path} ---\n${content}`;
        }).join('\n\n'));
    }

    /**
     * Run a bounded tool-use loop and return the model's final text.
     *
     * Bounded on purpose. An unbounded loop against a BYOK key is a way to
     * spend someone else's money without their knowledge; `maxIterations` is
     * the ceiling on how many rounds of exploration a single review can buy.
     * Hitting it is not an error — the model is told to answer with what it has.
     *
     * @param {Object} opts
     * @param {Array} opts.messages - initial messages
     * @param {Object} opts.settings - { provider, model, apiKey }
     * @param {string} opts.repoId
     * @param {number} [opts.maxIterations=4]
     * @param {Function} [opts.onProgress]
     * @returns {Promise<{content: string, usage: Object, toolCallCount: number, iterations: number, hitLimit: boolean}>}
     */
    async runToolLoop({ messages, settings, repoId, maxIterations = 4, onProgress = null }) {
        const usage = { input: 0, output: 0 };
        const convo = [...messages];
        let toolCallCount = 0;
        let iterations = 0;
        let content = '';
        let hitLimit = false;

        for (let i = 0; i < maxIterations; i++) {
            iterations = i + 1;

            const resp = await this.llmService.streamChat(convo, {
                provider: settings.provider,
                model: settings.model,
                apiKey: settings.apiKey,
                stream: false,
                tools: EXPLORER_TOOLS,
            });

            usage.input += resp?.usage?.input || 0;
            usage.output += resp?.usage?.output || 0;
            content = resp?.content || content;

            const calls = resp?.toolCalls || [];
            if (calls.length === 0) return { content, usage, toolCallCount, iterations, hitLimit };

            const echo = buildAssistantEcho(settings.provider, resp);
            if (!echo) {
                // Without the assistant turn the results would reference calls
                // the next request never saw. Stop with what we have rather
                // than send a malformed conversation.
                console.warn('RepoExplorer: no assistant echo available; ending loop');
                return { content, usage, toolCallCount, iterations, hitLimit };
            }
            convo.push(echo);

            onProgress?.({
                phase: 'exploring',
                message: `Exploring the repository (${calls.map(c => c.name).join(', ')})…`,
                iteration: iterations,
            });

            const results = [];
            for (const call of calls) {
                toolCallCount++;
                results.push({
                    id: call.id,
                    name: call.name,
                    result: await this.executeTool(call, repoId),
                });
            }
            convo.push(...buildToolResultMessages(settings.provider, results));

            // Last round: say so, so the model answers instead of asking again.
            if (i === maxIterations - 1) {
                hitLimit = true;
                convo.push({
                    role: 'user',
                    content: 'No further tool calls are available. Answer now using what you '
                        + 'have gathered, and do not claim anything you could not verify.',
                });
                const final = await this.llmService.streamChat(convo, {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false,
                });
                usage.input += final?.usage?.input || 0;
                usage.output += final?.usage?.output || 0;
                content = final?.content || content;
            }
        }

        return { content, usage, toolCallCount, iterations, hitLimit };
    }

    /**
     * Findings that required looking outside the diff.
     *
     * Shaped like `MultiFinderService.findAdditional` so it slots into the same
     * place in the pipeline: its output is deduped against the baseline, then
     * runs through citation enforcement and adversarial verification like any
     * other finding. Exploration buys recall; the existing precision machinery
     * still has to agree.
     *
     * @param {Array<Object>} baseline - findings already produced
     * @param {Object} opts
     * @returns {Promise<{findings: Array, stats: Object, usage: {input:number,output:number}}>}
     */
    async findWithExploration(baseline = [], opts = {}) {
        const {
            prData = {},
            settings = {},
            repoId,
            maxIterations = 4,
            onProgress = null,
        } = opts;

        const none = {
            findings: [],
            usage: { input: 0, output: 0 },
            stats: { ran: false, added: 0, toolCalls: 0, iterations: 0 },
        };

        if (!this.canExplore(settings.provider)) {
            console.log(
                `🔍 Repo exploration skipped: provider "${settings.provider}" has no tool support, `
                + 'or the repository is not indexed.',
            );
            return none;
        }
        if (!repoId) return none;

        const diffText = (prData.files || [])
            .map(f => `--- ${f.filename}\n${f.patch || ''}`)
            .join('\n');
        if (!diffText.trim()) return none;

        try {
            const user = buildExplorationPrompt({
                prTitle: prData.title,
                diffText,
                existingTitles: baseline.map(f => f.title || f.message || '').filter(Boolean),
            });

            const result = await this.runToolLoop({
                messages: [
                    { role: 'system', content: EXPLORER_SYSTEM_PROMPT },
                    { role: 'user', content: user },
                ],
                settings,
                repoId,
                maxIterations,
                onProgress,
            });

            const findings = parseExplorationFindings(result.content).map(f => ({
                ...f,
                source: 'llm',
                lens: 'repo-exploration',
            }));

            return {
                findings,
                usage: result.usage,
                stats: {
                    ran: true,
                    added: findings.length,
                    toolCalls: result.toolCallCount,
                    iterations: result.iterations,
                    hitLimit: result.hitLimit,
                },
            };
        } catch (e) {
            console.warn('Repo exploration failed (continuing without it):', e?.message);
            return none;
        }
    }
}

const EXPLORER_SYSTEM_PROMPT = `You are RepoSpector's repository explorer. Every other reviewer on this
panel sees only the diff plus whatever context was selected in advance. You can ASK the repository
questions, and your job is the class of finding that requires an answer: a change whose consequences
live in code that is not in the diff.

Worth exploring for:
- A changed signature, return shape, or thrown-error contract whose callers may not have been updated.
- A removed or renamed export still referenced elsewhere.
- A behavioural change (ordering, nullability, defaults, units) that a caller silently depends on.
- A new code path that contradicts how the same concern is handled elsewhere in this repo.

Not worth exploring for:
- Anything decidable from the diff alone. Another reviewer already covers it, and a duplicate finding
  costs the author attention without adding information.

How to work:
1. Read the diff and identify the symbols whose CONTRACT changed.
2. Use find_callers on those symbols, then read_file on the callers that look exposed.
3. Report a finding ONLY when you have read the consuming code and can name the concrete breakage.

Evidence rules — these decide whether a finding survives:
- Every finding must name the consumer you read and what specifically breaks in it.
- "This may affect callers" is not a finding. "handleUpload passes 2 arguments; this now requires 3"
  is a finding.
- If exploration showed the callers were already updated, report nothing. A clean result is a real
  result; inventing a finding to justify the exploration is the worst outcome here.
- Do not report on line numbers from indexed file excerpts — they are chunks, not the file. Cite
  line numbers only for lines in the diff.`;

/**
 * Build the user turn for an exploration pass.
 *
 * Diff first and stable, per-run state after it, so the block carries the cache
 * breakpoint (see promptCache).
 */
export function buildExplorationPrompt({ prTitle, diffText, existingTitles = [] }) {
    const stable = `## PR: ${prTitle || 'Unknown'}\n\n`
        + `## Diff under review\n\`\`\`diff\n${String(diffText || '').slice(0, 12000)}\n\`\`\`\n\n`;

    let tail = '## Findings already reported by other reviewers (do NOT repeat these)\n';
    tail += existingTitles.length
        ? existingTitles.slice(0, 40).map((t, i) => `${i + 1}. ${t}`).join('\n')
        : '(none yet)';
    tail += `\n\nExplore the repository as needed, then reply with JSON ONLY:
{
  "findings": [
    {
      "file": "path from the diff", "line": 42,
      "severity": "critical | high | medium | low",
      "type": "bug | security | performance | testing",
      "title": "concise (<100 chars)",
      "description": "what breaks, naming the consumer you read",
      "impact": "what happens in production",
      "suggestion": "specific fix",
      "evidence": "the file and symbol you inspected that proves this",
      "confidence": 0.0-1.0
    }
  ]
}
Return {"findings": []} if exploration showed nothing is broken.`;

    return [{ text: stable, cache: true }, { text: tail }];
}

/** Tolerant JSON extraction — models fence, prefix, and trail their JSON. */
export function parseExplorationFindings(text) {
    const raw = String(text || '');
    const candidates = [];

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1]);
    const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    if (braced) candidates.push(braced);
    candidates.push(raw);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate.trim());
            const list = Array.isArray(parsed) ? parsed : parsed?.findings;
            if (Array.isArray(list)) {
                return list.filter(f => f && typeof f === 'object' && (f.title || f.description));
            }
        } catch { /* try the next shape */ }
    }
    return [];
}

function truncate(text, limit = MAX_RESULT_CHARS) {
    const s = String(text ?? '');
    return s.length <= limit ? s : `${s.slice(0, limit)}\n… (truncated)`;
}

export default RepoExplorerService;

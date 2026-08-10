const {
    RepoExplorerService,
    EXPLORER_TOOLS,
    buildExplorationPrompt,
    parseExplorationFindings,
} = require('../../src/services/RepoExplorerService.js');
const { flattenContent } = require('../../src/utils/promptCache.js');

const FILE_SRC = 'export function handleUpload(file) {\n  return save(file);\n}\n';

function deps({ chunks = { 'src/api/upload.js': [{ chunkIndex: 0, content: FILE_SRC }] },
    callers = { save: [{ name: 'handleUpload', filePath: 'src/api/upload.js', confidence: 0.9 }] },
    searchResults = [{ filePath: 'src/db.js', content: 'export function save() {}' }] } = {}) {
    return {
        ragService: {
            vectorStore: {
                getChunksForFiles: async (_repo, paths) => {
                    const out = new Map();
                    for (const p of paths) if (chunks[p]) out.set(p, chunks[p]);
                    return out;
                },
            },
            retrieveContext: async () => searchResults,
        },
        codeGraphPipeline: {
            getCallerRefs: (symbol, limit) => (callers[symbol] || []).slice(0, limit),
        },
    };
}

/**
 * Scripted LLM: each entry is one turn's response. Records what it was sent so
 * the loop's protocol handling can be asserted.
 */
function scriptedLLM(turns) {
    const sent = [];
    let i = 0;
    return {
        sent,
        streamChat: jest.fn(async (messages, options) => {
            sent.push({ messages: JSON.parse(JSON.stringify(messages)), options });
            const turn = turns[Math.min(i, turns.length - 1)];
            i++;
            return { usage: { input: 10, output: 5 }, toolCalls: [], ...turn };
        }),
    };
}

describe('EXPLORER_TOOLS', () => {
    it('declares the three retrieval tools with required parameters', () => {
        const names = EXPLORER_TOOLS.map(t => t.function.name);
        expect(names).toEqual(['read_file', 'find_callers', 'search_repo']);
        for (const t of EXPLORER_TOOLS) {
            expect(t.function.parameters.required.length).toBeGreaterThan(0);
            // The description is what makes the model call the tool at the right
            // time; an empty one is a tool that never fires.
            expect(t.function.description.length).toBeGreaterThan(80);
        }
    });
});

describe('executeTool', () => {
    const repoId = 'gh:acme/widgets';
    let svc;
    beforeEach(() => { svc = new RepoExplorerService({ llmService: {}, ...deps() }); });

    it('read_file returns indexed source', async () => {
        const out = await svc.executeTool({ name: 'read_file', args: { path: 'src/api/upload.js' } }, repoId);
        expect(out).toContain('handleUpload');
        // The model must not compute line numbers from overlapping chunks.
        expect(out).toContain('do not cite line numbers');
    });

    it('read_file explains a miss instead of failing silently', async () => {
        const out = await svc.executeTool({ name: 'read_file', args: { path: 'nope.js' } }, repoId);
        expect(out).toContain('No indexed content');
    });

    it('find_callers returns names, paths and confidence', async () => {
        const out = await svc.executeTool({ name: 'find_callers', args: { symbol: 'save' } }, repoId);
        expect(out).toContain('handleUpload');
        expect(out).toContain('src/api/upload.js');
        expect(out).toContain('90% confidence');
    });

    it('find_callers says so when there are none', async () => {
        const out = await svc.executeTool({ name: 'find_callers', args: { symbol: 'ghost' } }, repoId);
        expect(out).toContain('No callers');
    });

    it('search_repo returns matches', async () => {
        const out = await svc.executeTool({ name: 'search_repo', args: { query: 'saving' } }, repoId);
        expect(out).toContain('src/db.js');
    });

    it('reports a missing required argument rather than throwing', async () => {
        expect(await svc.executeTool({ name: 'read_file', args: {} }, repoId))
            .toContain('requires a "path"');
        expect(await svc.executeTool({ name: 'find_callers', args: {} }, repoId))
            .toContain('requires a "symbol"');
    });

    it('reports an unknown tool rather than throwing', async () => {
        expect(await svc.executeTool({ name: 'rm_rf', args: {} }, repoId)).toContain('unknown tool');
    });

    it('turns a thrown store error into a readable result', async () => {
        const broken = new RepoExplorerService({
            llmService: {},
            ragService: { vectorStore: { getChunksForFiles: async () => { throw new Error('gone'); } } },
        });
        const out = await broken.executeTool({ name: 'read_file', args: { path: 'a.js' } }, repoId);
        expect(out).toContain('Error running read_file');
        expect(out).toContain('gone');
    });
});

describe('canExplore', () => {
    it('is false for providers without tool support', () => {
        const svc = new RepoExplorerService({ llmService: {}, ...deps() });
        expect(svc.canExplore('google')).toBe(false);
        expect(svc.canExplore('local')).toBe(false);
    });

    it('is true for the supported providers when the repo is indexed', () => {
        const svc = new RepoExplorerService({ llmService: {}, ...deps() });
        for (const p of ['openai', 'anthropic', 'groq', 'mistral']) {
            expect(svc.canExplore(p)).toBe(true);
        }
    });

    it('is false when there is no index to explore', () => {
        const svc = new RepoExplorerService({ llmService: {}, ragService: {} });
        expect(svc.canExplore('openai')).toBe(false);
    });
});

describe('runToolLoop', () => {
    const settings = { provider: 'openai', model: 'openai:gpt-5', apiKey: 'k' };
    const repoId = 'gh:acme/widgets';

    it('executes a requested tool and feeds the result back', async () => {
        const llm = scriptedLLM([
            {
                content: '',
                toolCalls: [{ id: 'c1', name: 'find_callers', args: { symbol: 'save' } }],
                raw: { content: null, tool_calls: [{ id: 'c1', function: { name: 'find_callers', arguments: '{}' } }] },
            },
            { content: '{"findings":[]}' },
        ]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.runToolLoop({
            messages: [{ role: 'user', content: 'go' }], settings, repoId,
        });

        expect(out.toolCallCount).toBe(1);
        expect(out.content).toBe('{"findings":[]}');
        // Second request carries the assistant echo plus the tool result.
        const second = llm.sent[1].messages;
        expect(second.some(m => m.role === 'assistant' && m.tool_calls?.length)).toBe(true);
        const toolMsg = second.find(m => m.role === 'tool');
        expect(toolMsg.content).toContain('handleUpload');
    });

    it('stops as soon as the model stops asking for tools', async () => {
        const llm = scriptedLLM([{ content: 'done', toolCalls: [] }]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.runToolLoop({ messages: [], settings, repoId });
        expect(llm.streamChat).toHaveBeenCalledTimes(1);
        expect(out.iterations).toBe(1);
        expect(out.hitLimit).toBe(false);
    });

    it('is bounded — a model that only ever calls tools cannot loop forever', async () => {
        // Unbounded here would be spending the user's own API budget without limit.
        const llm = scriptedLLM([{
            content: '',
            toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/api/upload.js' } }],
            raw: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
        }]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.runToolLoop({ messages: [], settings, repoId, maxIterations: 2 });

        expect(out.iterations).toBe(2);
        expect(out.hitLimit).toBe(true);
        // Two loop turns plus the forced final answer.
        expect(llm.streamChat).toHaveBeenCalledTimes(3);
        const last = llm.sent[llm.sent.length - 1];
        expect(JSON.stringify(last.messages)).toContain('No further tool calls are available');
        // The final answer request must NOT offer tools again.
        expect(last.options.tools).toBeUndefined();
    });

    it('accumulates usage across every turn', async () => {
        const llm = scriptedLLM([
            {
                content: '',
                toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/api/upload.js' } }],
                raw: { content: null, tool_calls: [] },
            },
            { content: 'ok' },
        ]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.runToolLoop({ messages: [], settings, repoId });
        expect(out.usage.input).toBe(20);
        expect(out.usage.output).toBe(10);
    });
});

describe('buildExplorationPrompt', () => {
    it('marks the diff as the cacheable part and keeps run state after it', () => {
        const parts = buildExplorationPrompt({
            prTitle: 't', diffText: '+const a = 1;', existingTitles: ['Existing finding'],
        });
        const cached = parts.find(p => p.cache);
        expect(cached.text).toContain('+const a = 1;');
        expect(cached.text).not.toContain('Existing finding');
        expect(flattenContent(parts)).toContain('Existing finding');
    });
});

describe('parseExplorationFindings', () => {
    it('parses a bare JSON object', () => {
        expect(parseExplorationFindings('{"findings":[{"title":"a"}]}')).toHaveLength(1);
    });

    it('parses fenced JSON', () => {
        expect(parseExplorationFindings('```json\n{"findings":[{"title":"a"}]}\n```')).toHaveLength(1);
    });

    it('parses JSON with prose around it', () => {
        expect(parseExplorationFindings('Here you go:\n{"findings":[{"title":"a"}]}\nHope that helps'))
            .toHaveLength(1);
    });

    it('returns empty for unparseable output rather than throwing', () => {
        expect(parseExplorationFindings('I could not determine anything.')).toEqual([]);
        expect(parseExplorationFindings('')).toEqual([]);
    });

    it('drops entries with neither a title nor a description', () => {
        expect(parseExplorationFindings('{"findings":[{"line":4},{"title":"real"}]}')).toHaveLength(1);
    });
});

describe('findWithExploration', () => {
    const repoId = 'gh:acme/widgets';
    const prData = { title: 'Change save()', files: [{ filename: 'src/db.js', patch: '+function save(a,b){}' }] };

    it('skips providers with no tool support, without calling the model', async () => {
        const llm = scriptedLLM([{ content: '{}' }]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.findWithExploration([], {
            prData, settings: { provider: 'google' }, repoId,
        });
        expect(out.stats.ran).toBe(false);
        expect(llm.streamChat).not.toHaveBeenCalled();
    });

    it('tags findings so the pipeline can attribute them', async () => {
        const llm = scriptedLLM([{ content: '{"findings":[{"title":"caller breaks","file":"src/db.js","line":1}]}' }]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.findWithExploration([], {
            prData, settings: { provider: 'openai', model: 'openai:gpt-5', apiKey: 'k' }, repoId,
        });
        expect(out.findings).toHaveLength(1);
        expect(out.findings[0].lens).toBe('repo-exploration');
        expect(out.findings[0].source).toBe('llm');
        expect(out.stats.ran).toBe(true);
    });

    it('reports nothing when exploration found nothing broken', async () => {
        // A clean result is a real result; a finding invented to justify the
        // exploration is the worst outcome this pass can produce.
        const llm = scriptedLLM([{ content: '{"findings":[]}' }]);
        const svc = new RepoExplorerService({ llmService: llm, ...deps() });
        const out = await svc.findWithExploration([], {
            prData, settings: { provider: 'openai', model: 'openai:gpt-5', apiKey: 'k' }, repoId,
        });
        expect(out.findings).toEqual([]);
        expect(out.stats.added).toBe(0);
    });

    it('degrades to no findings when the model call throws', async () => {
        const svc = new RepoExplorerService({
            llmService: { streamChat: async () => { throw new Error('rate limited'); } },
            ...deps(),
        });
        const out = await svc.findWithExploration([], {
            prData, settings: { provider: 'openai', model: 'openai:gpt-5', apiKey: 'k' }, repoId,
        });
        expect(out.findings).toEqual([]);
        expect(out.stats.ran).toBe(false);
    });
});

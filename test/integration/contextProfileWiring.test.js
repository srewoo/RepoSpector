/**
 * Guards exactly the failure mode this repo already had once:
 * `REPOSPECTOR_CONTEXT_PROFILE` was fully documented (reviewContextBudget.js,
 * constants.js, eval/run.js) but read NOWHERE — a switch that looked wired
 * and did nothing.
 *
 * This does not re-call `resolveBudget()` and compare it to itself (that
 * would only prove resolveBudget() is deterministic, not that anything
 * downstream reads its output). Instead it drives the REAL
 * `MultiPassReviewEngine.execute()` — the same entry point `eval/run.js` and
 * `prReviewHandlers.js` call — with `context.contextBudget` set to a resolved
 * profile, and inspects the actual prompt text handed to the (mocked) LLM.
 * If a future refactor stops forwarding `contextBudget` to the prompt
 * builder, this test fails; re-calling resolveBudget() in isolation would not
 * have caught that.
 */

const { MultiPassReviewEngine } = require('../../src/services/MultiPassReviewEngine.js');
const { resolveBudget, DEFAULT_BUDGET, LEGACY_BUDGET } = require('../../src/utils/reviewContextBudget.js');
const { PER_FILE_REVIEW_SYSTEM_PROMPT } = require('../../src/utils/multiPassPrompts.js');
const { flattenContent } = require('../../src/utils/promptCache.js');

function fixturePR() {
    return {
        state: 'open',
        isDraft: false,
        mergeable: true,
        author: { login: 'alice' },
        title: 'Add search endpoint',
        stats: { additions: 1, deletions: 0 },
        commits: [{ sha: 'abc1234', message: 'feat: add search' }],
        files: [{
            filename: 'src/foo.js',
            additions: 1,
            deletions: 0,
            language: 'javascript',
            patch: '@@ -1,0 +1,1 @@\n+const x = 1;',
        }],
    };
}

/** Big enough that legacy vs default truncation is unambiguous either way. */
const GRAPH_TEXT = 'G'.repeat(15000); // > DEFAULT (12000) and > LEGACY (4000)
const RAG_TEXT = 'q'.repeat(5000);    // > DEFAULT (2000) and > LEGACY (600)

function makeContext(contextBudget) {
    return {
        staticFindings: [],
        contextBudget,
        // One chunk per file — MultiPassReviewEngine's own per-unit cap
        // (`_getRAGChunksForUnit` slices to 3) would otherwise mask a
        // ragChunks-COUNT difference; using char-length differences instead
        // (ragChunkChars, graphContextChars) isolates what resolveBudget()
        // actually gates through this path.
        ragContext: { byFile: { 'src/foo.js': [{ filePath: 'src/foo.js', content: RAG_TEXT }] } },
        graphContext: { byFile: { 'src/foo.js': GRAPH_TEXT } },
    };
}

/** Stub LLM that records every per-file prompt it was sent. */
function makeCapturingLLM(capturedPrompts) {
    return {
        streamChat: jest.fn(async (messages) => {
            const isPerFile = messages?.[0]?.content === PER_FILE_REVIEW_SYSTEM_PROMPT;
            if (isPerFile) {
                capturedPrompts.push(flattenContent(messages[1].content));
                return {
                    content: JSON.stringify({
                        file: 'src/foo.js',
                        language: 'javascript',
                        fileVerdict: 'APPROVE',
                        riskLevel: 'LOW',
                        findings: [],
                        positives: [],
                    }),
                    usage: { input: 10, output: 5 },
                };
            }
            return { content: 'synthesis', usage: { input: 5, output: 2 } };
        }),
    };
}

async function runWithProfile(contextBudget) {
    const prompts = [];
    const llm = makeCapturingLLM(prompts);
    const engine = new MultiPassReviewEngine({ llmService: llm });
    await engine.execute(
        fixturePR(),
        makeContext(contextBudget),
        { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-test' },
        { focusAreas: ['bugs'], maxConcurrent: 1 },
        null,
    );
    expect(prompts.length).toBeGreaterThan(0);
    return prompts[0];
}

/** Longest run of a repeated character actually present in the prompt. */
function longestRunOf(text, char) {
    const matches = text.match(new RegExp(`${char}+`, 'g')) || [''];
    return Math.max(...matches.map((m) => m.length));
}

describe('REPOSPECTOR_CONTEXT_PROFILE wiring reaches the real prompt builder', () => {
    it('a legacy-resolved budget produces a smaller graph/RAG block than the default', async () => {
        const legacyBudget = resolveBudget({ profile: 'legacy' });
        const defaultBudget = resolveBudget(); // what an unset env var resolves to

        const legacyPrompt = await runWithProfile(legacyBudget);
        const defaultPrompt = await runWithProfile(defaultBudget);

        // Graph context: MultiPassReviewEngine._getGraphContextForUnit prefixes
        // the raw block with `### src/foo.js\n` before the prompt builder
        // slices to budget.graphContextChars, so the surviving run of 'G' is
        // a few characters short of the budget itself — the point here isn't
        // the exact offset, it's that default keeps substantially MORE of the
        // 15000-char block than legacy, and neither keeps it all.
        const legacyGraphRun = longestRunOf(legacyPrompt, 'G');
        const defaultGraphRun = longestRunOf(defaultPrompt, 'G');
        expect(legacyGraphRun).toBeLessThan(LEGACY_BUDGET.graphContextChars);
        expect(legacyGraphRun).toBeGreaterThan(LEGACY_BUDGET.graphContextChars - 50);
        expect(defaultGraphRun).toBeLessThan(DEFAULT_BUDGET.graphContextChars);
        expect(defaultGraphRun).toBeGreaterThan(DEFAULT_BUDGET.graphContextChars - 50);
        expect(defaultGraphRun).toBeGreaterThan(legacyGraphRun);
        expect(defaultPrompt.length).toBeGreaterThan(legacyPrompt.length);

        // RAG chunk: default keeps more characters of the single retrieved
        // chunk than legacy does (no header prefix here, so this is exact).
        expect(defaultPrompt).toContain('q'.repeat(DEFAULT_BUDGET.ragChunkChars));
        expect(legacyPrompt).toContain('q'.repeat(LEGACY_BUDGET.ragChunkChars));
        expect(legacyPrompt).not.toContain('q'.repeat(LEGACY_BUDGET.ragChunkChars + 1));
    });

    it('omitting contextBudget (as an unwired switch would) falls back to the raised defaults, not legacy', async () => {
        // This is the regression the missing wiring actually produced: with no
        // env var read anywhere, every eval run silently got DEFAULT_BUDGET
        // regardless of what REPOSPECTOR_CONTEXT_PROFILE said.
        const prompt = await runWithProfile(null);
        const graphRun = longestRunOf(prompt, 'G');
        expect(graphRun).toBeGreaterThan(LEGACY_BUDGET.graphContextChars);
        expect(graphRun).toBeLessThan(DEFAULT_BUDGET.graphContextChars);
        expect(prompt).toContain('q'.repeat(DEFAULT_BUDGET.ragChunkChars));
    });
});

const { FindingFollowupService } = require('../../src/services/FindingFollowupService.js');

function makeLLM(impl) {
    return { streamChat: jest.fn(impl) };
}

const finding = {
    id: 'f1',
    severity: 'blocking',
    category: 'security',
    file: 'src/db/users.js',
    line: 42,
    rule: 'sec:sql-injection',
    title: 'SQL injection',
    suggestion: 'Parameterize the query',
    evidence: 'db.query("SELECT * FROM u WHERE id=" + id)',
};
const settings = { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' };

describe('FindingFollowupService', () => {
    it('throws without llmService', () => {
        expect(() => new FindingFollowupService({})).toThrow(/llmService/);
    });

    it('explain() calls LLM with explain system prompt + finding context', async () => {
        const llm = makeLLM(async (messages) => {
            expect(messages[0].role).toBe('system');
            expect(messages[0].content).toMatch(/explain/i);
            expect(messages[1].content).toMatch(/SQL injection/);
            expect(messages[1].content).toMatch(/sec:sql-injection/);
            expect(messages[1].content).toMatch(/db\.query/);
            return { content: 'because string concat = SQLi', usage: { input: 100, output: 30 } };
        });
        const svc = new FindingFollowupService({ llmService: llm });
        const r = await svc.explain({ finding, settings });
        expect(r.content).toMatch(/SQLi/);
        expect(r.tokensIn).toBe(100);
        expect(r.tokensOut).toBe(30);
    });

    it('suggestFix() uses fix system prompt', async () => {
        const llm = makeLLM(async (messages) => {
            expect(messages[0].content).toMatch(/minimal fix/i);
            return { content: '```diff\n- db.query(...)\n+ db.query("SELECT * FROM u WHERE id=$1", [id])\n```' };
        });
        const svc = new FindingFollowupService({ llmService: llm });
        const r = await svc.suggestFix({ finding, settings });
        expect(r.content).toMatch(/\+/);
        expect(llm.streamChat).toHaveBeenCalledTimes(1);
    });

    it('caches results across repeat calls', async () => {
        const llm = makeLLM(async () => ({ content: 'cached!' }));
        const svc = new FindingFollowupService({ llmService: llm });
        await svc.explain({ finding, settings });
        await svc.explain({ finding, settings });
        expect(llm.streamChat).toHaveBeenCalledTimes(1);
    });

    it('explain and fix use independent cache keys', async () => {
        const llm = makeLLM(async () => ({ content: 'x' }));
        const svc = new FindingFollowupService({ llmService: llm });
        await svc.explain({ finding, settings });
        await svc.suggestFix({ finding, settings });
        expect(llm.streamChat).toHaveBeenCalledTimes(2);
    });

    it('includes surrounding code when provided', async () => {
        const llm = makeLLM(async (messages) => {
            expect(messages[1].content).toMatch(/surrounding code/i);
            expect(messages[1].content).toMatch(/function getUser/);
            return { content: 'ok' };
        });
        const svc = new FindingFollowupService({ llmService: llm });
        await svc.explain({ finding, code: 'function getUser(id) { ... }', settings });
    });

    it('clearCache forces re-call', async () => {
        const llm = makeLLM(async () => ({ content: 'r' }));
        const svc = new FindingFollowupService({ llmService: llm });
        await svc.explain({ finding, settings });
        svc.clearCache();
        await svc.explain({ finding, settings });
        expect(llm.streamChat).toHaveBeenCalledTimes(2);
    });

    it('rejects on missing apiKey', async () => {
        const svc = new FindingFollowupService({ llmService: makeLLM(async () => ({})) });
        await expect(svc.explain({ finding, settings: { provider: 'openai', model: 'm' } }))
            .rejects.toThrow(/apiKey/);
    });
});

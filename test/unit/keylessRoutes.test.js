/**
 * Step 1 of the old welcome panel was "Add your API key", which is the whole
 * funnel for a user who has no key. These tests pin that the panel ranks by
 * time-to-first-result, that a working Ollama outranks the weaker on-device
 * model, and that an unavailable route explains itself instead of offering a
 * button that cannot work.
 */
const { CHROME_AI_AVAILABILITY } = require('../../src/utils/chromeAI.js');
const { OLLAMA_VERDICT } = require('../../src/utils/ollamaProbe.js');
const { ROUTE_IDS, rankKeylessRoutes } = require('../../src/popup/utils/keylessRoutes.js');

const ids = (rows) => rows.map((r) => r.id);

describe('rankKeylessRoutes', () => {
    test('a working Ollama outranks an available on-device model', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.AVAILABLE,
            ollama: OLLAMA_VERDICT.OK,
            hasKey: false,
        });
        expect(ids(rows).indexOf(ROUTE_IDS.OLLAMA))
            .toBeLessThan(ids(rows).indexOf(ROUTE_IDS.CHROME_AI));
        expect(rows[0].tier).toBe('Ready now');
    });

    test('with no Ollama, an available on-device model leads', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.AVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: false,
        });
        expect(rows[0].id).toBe(ROUTE_IDS.CHROME_AI);
        expect(rows[0].tier).toBe('Ready now');
    });

    test('the API-key route is always offered', () => {
        for (const chromeAI of Object.values(CHROME_AI_AVAILABILITY)) {
            for (const ollama of Object.values(OLLAMA_VERDICT)) {
                expect(ids(rankKeylessRoutes({ chromeAI, ollama, hasKey: false })))
                    .toContain(ROUTE_IDS.API_KEY);
            }
        }
    });

    test('an unavailable on-device model is disabled and says why', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: false,
            chromeAIReason: 'Needs Chrome 138 or newer.',
        });
        const row = rows.find((r) => r.id === ROUTE_IDS.CHROME_AI);
        expect(row.enabled).toBe(false);
        expect(row.detail).toContain('Chrome 138');
    });

    test('a CORS-blocked Ollama is offered as a fix, not as ready', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.CORS_BLOCKED,
            hasKey: false,
        });
        const row = rows.find((r) => r.id === ROUTE_IDS.OLLAMA);
        expect(row.tier).not.toBe('Ready now');
        expect(row.detail).toMatch(/allow|origin/i);
    });

    test('the MCP row appears only when published', () => {
        const base = { chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE, ollama: OLLAMA_VERDICT.NOT_RUNNING, hasKey: false };
        expect(ids(rankKeylessRoutes({ ...base, mcpPublished: false }))).not.toContain(ROUTE_IDS.MCP);
        expect(ids(rankKeylessRoutes({ ...base, mcpPublished: true }))).toContain(ROUTE_IDS.MCP);
    });

    test('an existing key moves the key row to Ready now', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: true,
        });
        expect(rows[0].id).toBe(ROUTE_IDS.API_KEY);
        expect(rows[0].tier).toBe('Ready now');
    });

    test('every row is renderable — id, tier, label, action, enabled', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.DOWNLOADABLE,
            ollama: OLLAMA_VERDICT.MODEL_MISSING,
            hasKey: false,
            mcpPublished: true,
        });
        for (const r of rows) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.tier).toBe('string');
            expect(r.label.length).toBeGreaterThan(0);
            expect(typeof r.action).toBe('string');
            expect(typeof r.enabled).toBe('boolean');
        }
    });
});

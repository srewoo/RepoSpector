const { DETERMINISTIC_SOURCES, isDeterministicSource } = require('../../src/utils/findingSources.js');

describe('isDeterministicSource', () => {
    it('treats static, external and graph as deterministic', () => {
        for (const s of ['static', 'external', 'graph']) expect(isDeterministicSource(s)).toBe(true);
        expect(DETERMINISTIC_SOURCES).toEqual(expect.arrayContaining(['static', 'external', 'graph']));
    });
    it('treats llm, ai and undefined as model output', () => {
        for (const s of ['llm', 'ai', undefined, null]) expect(isDeterministicSource(s)).toBe(false);
    });
});

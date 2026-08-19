/**
 * Model-list ranking — "latest first", which is the dropdown's whole purpose.
 *
 * Measured against a live OpenAI key before this existed: 80 ids, ordered by
 * `b.localeCompare(a)` (reverse alphabetical). That put `o4-mini-2025-04-16`
 * first and the newest flagship, `gpt-5.6-*`, at position **15** — below
 * fourteen older reasoning models. 29 of the 80 were dated snapshots duplicating
 * a stable alias already in the list.
 */

const { rankModels } = require('../../src/services/ModelCatalogService.js');

const ids = (list) => list.map(m => m.id);

describe('rankModels', () => {
    it('puts the newest version first, across families', () => {
        const out = rankModels([
            { id: 'openai:o4-mini' },
            { id: 'openai:gpt-4.1' },
            { id: 'openai:gpt-5.6-sol' },
            { id: 'openai:o1' },
        ]);
        expect(ids(out)[0]).toBe('openai:gpt-5.6-sol');
    });

    it('orders by minor version, not string comparison', () => {
        // "gpt-5.10" > "gpt-5.9" numerically but sorts LOWER as a string.
        const out = rankModels([{ id: 'openai:gpt-5.9' }, { id: 'openai:gpt-5.10' }]);
        expect(ids(out)[0]).toBe('openai:gpt-5.10');
    });

    it('drops a dated snapshot when its stable alias is present', () => {
        const out = rankModels([
            { id: 'openai:o4-mini-2025-04-16' },
            { id: 'openai:o4-mini' },
        ]);
        expect(ids(out)).toEqual(['openai:o4-mini']);
    });

    it('KEEPS a dated snapshot when there is no stable alias to prefer', () => {
        // Pinning to a snapshot is legitimate; only the duplicate is noise.
        const out = rankModels([{ id: 'openai:gpt-5.5-pro-2026-04-23' }]);
        expect(ids(out)).toEqual(['openai:gpt-5.5-pro-2026-04-23']);
    });

    it('prefers the stable alias over a same-version variant', () => {
        const out = rankModels([{ id: 'openai:gpt-5.6-terra' }, { id: 'openai:gpt-5.6' }]);
        expect(ids(out)[0]).toBe('openai:gpt-5.6');
    });

    it('marks exactly one model recommended — the top one', () => {
        const out = rankModels([
            { id: 'openai:gpt-4.1' }, { id: 'openai:gpt-5.6' }, { id: 'openai:o1' },
        ]);
        expect(out.filter(m => m.recommended)).toHaveLength(1);
        expect(out[0].recommended).toBe(true);
    });

    it('sorts an unversioned id last instead of guessing at it', () => {
        const out = rankModels([{ id: 'openai:chatgpt-latest' }, { id: 'openai:gpt-4.1' }]);
        expect(ids(out)[ids(out).length - 1]).toBe('openai:chatgpt-latest');
    });

    it('handles an empty list without throwing', () => {
        expect(rankModels([])).toEqual([]);
    });
});

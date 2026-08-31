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

describe('rankModels — fine-tuned models', () => {
    // A fine-tune is `ft:<base>:<org>::<suffix>`. Measured against a real key:
    // 15 of the 22 models the family filter rejected were that org's OWN
    // fine-tunes — the one category of model a team can be certain it wants, and
    // the only one the dropdown could not show.
    const FT = 'openai:ft:gpt-3.5-turbo-0613:acme-dev::88pNyu07';

    it('ranks a fine-tune by its BASE model, not by its id suffix', () => {
        // `split(':').pop()` yielded `88pNyu07`, whose leading digits read as
        // "version 88" — so every fine-tune outranked the newest flagship and one
        // of them took the ⭐.
        const ranked = rankModels([
            { id: FT, name: 'ft' },
            { id: 'openai:gpt-5.6-sol', name: 'sol' },
            { id: 'openai:gpt-4.1', name: '4.1' },
        ]);

        expect(ids(ranked)[0]).toBe('openai:gpt-5.6-sol');
        expect(ranked[0].recommended).toBe(true);
        // 3.5 base, so it sorts below 4.1.
        expect(ids(ranked)[2]).toBe(FT);
    });

    it('never gives the star to a fine-tune when a newer base model exists', () => {
        const ranked = rankModels([{ id: FT, name: 'ft' }, { id: 'openai:gpt-5', name: '5' }]);
        expect(ranked.find(m => m.recommended).id).toBe('openai:gpt-5');
    });

    it('orders two fine-tunes by their own base versions', () => {
        const ranked = rankModels([
            { id: 'openai:ft:gpt-3.5-turbo-0613:acme::a', name: 'old' },
            { id: 'openai:ft:gpt-4.1-mini:acme::b', name: 'new' },
        ]);
        expect(ids(ranked)[0]).toBe('openai:ft:gpt-4.1-mini:acme::b');
    });

    it('does not mistake a fine-tune for a dated snapshot', () => {
        // `ft:gpt-3.5-turbo-0613:...` contains no trailing date, and the base's
        // `-0613` must not be read as one.
        const ranked = rankModels([{ id: FT, name: 'ft' }]);
        expect(ids(ranked)).toEqual([FT]);
    });

    it('keeps ranking ids that contain no colon beyond the provider', () => {
        const ranked = rankModels([
            { id: 'openai:chat-latest', name: 'chat-latest' },
            { id: 'openai:gpt-5.6-sol', name: 'sol' },
        ]);
        expect(ids(ranked)[0]).toBe('openai:gpt-5.6-sol');
    });
});

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

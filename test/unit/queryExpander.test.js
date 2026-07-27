/**
 * Regression tests for queryExpander.
 *
 * The bug these exist for: CODE_SYNONYMS and ABBREVIATIONS are object literals,
 * so they inherit Object.prototype. A query token of `constructor` (or
 * `toString`, `valueOf`, `hasOwnProperty`, ...) made `CODE_SYNONYMS[token]`
 * return the inherited FUNCTION — truthy, so it passed the `if` guard, then
 * threw "CODE_SYNONYMS[token].slice is not a function".
 *
 * `expandQuery` runs inside `RAGService.retrieveContext`, whose catch swallows
 * everything into "❌ RAG retrieval failed" and returns []. So the whole
 * retrieval layer went dark, silently, for any query containing the single most
 * common word in object-oriented code.
 */

const { expandQuery } = require('../../src/utils/queryExpander.js');

const PROTOTYPE_KEYS = [
    'constructor',
    'tostring',
    'valueof',
    'hasownproperty',
    'isprototypeof',
    'propertyisenumerable',
    'tolocalestring',
    '__proto__',
    '__definegetter__',
    '__lookupgetter__',
];

describe('expandQuery — prototype-key safety', () => {
    it.each(PROTOTYPE_KEYS)('does not throw on the token %s', (token) => {
        expect(() => expandQuery(`class Foo { ${token}(a) { return a } }`)).not.toThrow();
    });

    it('does not throw on a realistic code query containing constructor', () => {
        const query = [
            'src/services/UserService.js',
            'class UserService {',
            '  constructor(db) { this.db = db; }',
            '  toString() { return `UserService`; }',
            '}',
        ].join('\n');
        expect(() => expandQuery(query)).not.toThrow();
    });

    it('never emits a non-string expansion', () => {
        // The inherited value is a function; if it leaked through it would be
        // added to the term set and stringified into the search query.
        const r = expandQuery('constructor tostring valueof function');
        expect(r.expansions.every(e => typeof e.expansion === 'string')).toBe(true);
        expect(r.terms.every(t => typeof t === 'string')).toBe(true);
        expect(typeof r.expandedQuery).toBe('string');
        expect(r.expandedQuery).not.toMatch(/function \w*\(\)|\[native code\]|\[object /);
    });

    it('treats a prototype key as an ordinary unknown token', () => {
        const r = expandQuery('constructor');
        expect(r.expansions.filter(e => e.original === 'constructor')).toHaveLength(0);
    });
});

describe('expandQuery — normal behaviour still works', () => {
    it('expands known synonyms', () => {
        const r = expandQuery('function');
        const syns = r.expansions.filter(e => e.type === 'synonym').map(e => e.expansion);
        expect(syns.length).toBeGreaterThan(0);
        expect(syns).toEqual(expect.arrayContaining(['method']));
    });

    it('expands known abbreviations', () => {
        const r = expandQuery('auth db');
        const abbr = r.expansions.filter(e => e.type === 'abbreviation').map(e => e.expansion);
        expect(abbr).toEqual(expect.arrayContaining(['authentication', 'database']));
    });

    it('respects maxExpansions', () => {
        const r = expandQuery('create', { maxExpansions: 2 });
        expect(r.expansions.filter(e => e.type === 'synonym' && e.original === 'create').length)
            .toBeLessThanOrEqual(2);
    });

    it('can disable synonym and abbreviation expansion', () => {
        const r = expandQuery('function auth', { includeSynonyms: false, includeAbbreviations: false });
        expect(r.expansions.filter(e => e.type === 'synonym')).toHaveLength(0);
        expect(r.expansions.filter(e => e.type === 'abbreviation')).toHaveLength(0);
    });

    it('handles an empty query without throwing', () => {
        expect(() => expandQuery('')).not.toThrow();
    });
});

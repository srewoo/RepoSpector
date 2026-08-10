/**
 * The recall denominator.
 *
 * Whatever `toReferences` marks substantive is what the reviewer is scored
 * against, so this filter decides the headline number. Too generous and recall
 * is unreachable by construction; too strict and it flatters the tool by
 * dropping exactly the hard comments. These tests pin the boundary in both
 * directions.
 */

const { toReferences, isSubstantive, isBot } = require('../../eval/lib/humanComments.js');

const sub = (comments) => toReferences(comments).filter(r => r.substantive);

describe('isBot', () => {
    it('catches the [bot] suffix GitHub appends to Apps', () => {
        expect(isBot('coderabbitai[bot]')).toBe(true);
        expect(isBot('some-random-app[bot]')).toBe(true);
    });

    it('catches known review bots by bare login', () => {
        expect(isBot('dependabot')).toBe(true);
        expect(isBot('CODECOV')).toBe(true);
    });

    it('does not catch humans', () => {
        expect(isBot('jreback')).toBe(false);
        expect(isBot('')).toBe(false);
    });
});

describe('isSubstantive', () => {
    it('counts a real review request', () => {
        expect(isSubstantive({ author: 'dev', body: 'Can you factor this into a separate function? It is getting long.' })).toBe(true);
    });

    it('counts design and naming comments, not just defect reports', () => {
        // These are the comments a generic rule set structurally cannot make;
        // filtering them out would be the flattering mistake.
        expect(isSubstantive({ author: 'dev', body: 'Why not reuse the existing shared http status helper here?' })).toBe(true);
        expect(isSubstantive({ author: 'dev', body: 'Naming: tenant_id everywhere else in this package, not tenantID.' })).toBe(true);
    });

    it('excludes pure acknowledgements', () => {
        for (const body of ['LGTM', 'lgtm!', 'thanks', 'Done', '👍', 'sgtm']) {
            expect(isSubstantive({ author: 'dev', body })).toBe(false);
        }
    });

    it('excludes a short reply hiding under a long quote', () => {
        const body = '> a very long quoted paragraph that goes on and on and on and on\n\nDone';
        expect(isSubstantive({ author: 'dev', body })).toBe(false);
    });

    it('does not let a code fence alone make a comment substantive', () => {
        expect(isSubstantive({ author: 'dev', body: '```python\nx = 1\n```\nok' })).toBe(false);
    });

    it('excludes bots however long they write', () => {
        expect(isSubstantive({
            author: 'coderabbitai[bot]',
            body: 'This function has a potential null dereference on the error path and should be guarded.',
        })).toBe(false);
    });

    it('excludes thread replies — the root is what the human raised', () => {
        const body = 'does `block_fast_lane` match what you had in mind here?';
        expect(isSubstantive({ author: 'dev', body })).toBe(true);
        expect(isSubstantive({ author: 'dev', body, inReplyTo: 12345 })).toBe(false);
    });
});

describe('toReferences', () => {
    it('collapses a five-message thread to the one root request', () => {
        // The bug this guards: GitHub returns every message in a thread as its
        // own comment at the same path and line, so one disputed issue counted
        // five times and made recall unreachable.
        const thread = [
            { path: 'a.c', line: 918, author: 'rev', body: 'Can you factor this into a separate function please?' },
            { path: 'a.c', line: 918, author: 'dev', body: 'does block_fast_lane match what you had in mind?', inReplyTo: 1 },
            { path: 'a.c', line: 918, author: 'rev', body: 'Still need to give this a proper look, it got better though.', inReplyTo: 1 },
            { path: 'a.c', line: 918, author: 'dev', body: 'my plan is to do a refactor PR after the current ones merge', inReplyTo: 1 },
        ];
        expect(sub(thread)).toHaveLength(1);
        expect(sub(thread)[0].body).toMatch(/factor this into a separate function/);
    });

    it('excludes a comment with no file, which could never be matched', () => {
        expect(sub([{ author: 'dev', body: 'Overall this approach seems reasonable to me, but see below.' }])).toHaveLength(0);
    });

    it('keeps excluded comments with a reason, so the denominator is auditable', () => {
        const refs = toReferences([
            { path: 'a.js', line: 1, author: 'dependabot[bot]', body: 'Bumps lodash from 1 to 2 with a long changelog attached.' },
            { path: 'a.js', line: 2, author: 'dev', body: 'LGTM' },
            { path: 'a.js', line: 3, author: 'dev', body: 'reply text that is quite long indeed', inReplyTo: 9 },
            { author: 'dev', body: 'a PR-level comment with plenty of words in it' },
        ]);
        expect(refs).toHaveLength(4);
        expect(refs.every(r => !r.substantive)).toBe(true);
        expect(refs.map(r => r.excludedReason)).toEqual([
            'bot',
            'acknowledgement or too short',
            'thread reply (root already counted)',
            'no file (PR-level comment)',
        ]);
    });

    it('preserves the line for matching, and null when absent', () => {
        const [withLine, withoutLine] = toReferences([
            { path: 'a.js', line: 42, author: 'dev', body: 'This needs a guard for the empty case.' },
            { path: 'a.js', author: 'dev', body: 'This whole file needs a guard for the empty case.' },
        ]);
        expect(withLine.line).toBe(42);
        expect(withoutLine.line).toBeNull();
    });
});

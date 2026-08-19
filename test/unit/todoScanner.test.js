/**
 * The two things worth pinning: markers are found only on ADDED lines (a
 * pre-existing TODO in a touched file is not news), and the comment-leader
 * requirement holds (without it, `const TODO_STATES` and every user-facing
 * string containing "todo" match — which in a codebase with a task feature is
 * most of them).
 */
const {
    scanAddedTodos,
    renderTodoSection,
    TODO_DEFAULTS,
} = require('../../src/utils/todoScanner.js');

const pr = (patch, filename = 'src/a.js') => ({ files: [{ filename, patch }] });

describe('scanAddedTodos — what counts', () => {
    it('finds a TODO on an added line, with its real file line number', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -10,2 +10,4 @@',
            ' const a = 1;',
            '+// TODO: handle the empty case',
            '+const b = 2;',
            ' const c = 3;',
        ].join('\n')));

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            file: 'src/a.js', line: 11, keyword: 'TODO', note: 'handle the empty case',
        });
    });

    it('ignores a pre-existing marker on a context line', () => {
        const { items, total } = scanAddedTodos(pr([
            '@@ -1,3 +1,4 @@',
            ' // TODO: this was already here',
            '+const added = 1;',
        ].join('\n')));
        expect(total).toBe(0);
        expect(items).toEqual([]);
    });

    it('ignores a marker on a removed line', () => {
        const { total } = scanAddedTodos(pr([
            '@@ -1,2 +1,1 @@',
            '-// FIXME: being deleted by this PR',
            ' const kept = 1;',
        ].join('\n')));
        expect(total).toBe(0);
    });

    it('does not match an identifier or a string literal', () => {
        const { total } = scanAddedTodos(pr([
            '@@ -1 +1,4 @@',
            '+const TODO_STATES = ["open", "done"];',
            '+const label = "Add a todo item";',
            '+function fixmeLater() {}',
        ].join('\n')));
        expect(total).toBe(0);
    });

    it('recognises the marker across comment syntaxes', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -1 +1,6 @@',
            '+# TODO: python',
            '+/* FIXME: block */',
            '+  * HACK: continuation',
            '+<!-- TODO: markup -->',
            '+-- TODO: sql',
        ].join('\n')));
        expect(items.map(i => i.keyword).sort())
            .toEqual(['FIXME', 'HACK', 'TODO', 'TODO', 'TODO']);
    });

    it('strips an owner or ticket prefix from the note', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -1 +1,2 @@',
            '+// TODO(alice): wire up retries',
        ].join('\n')));
        expect(items[0].note).toBe('wire up retries');
    });

    it('marks a marker that references a ticket as tracked', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -1 +1,3 @@',
            '+// TODO: PROJ-123 split this out',
            '+// TODO: no ticket here',
        ].join('\n')));
        const tracked = items.find(i => i.note.includes('PROJ-123'));
        const untracked = items.find(i => i.note.includes('no ticket'));
        expect(tracked.tracked).toBe(true);
        expect(untracked.tracked).toBe(false);
    });

    it('handles a missing patch or empty PR without throwing', () => {
        expect(scanAddedTodos({ files: [{ filename: 'a.js' }] }).total).toBe(0);
        expect(scanAddedTodos({}).total).toBe(0);
        expect(scanAddedTodos(null).total).toBe(0);
    });
});

describe('scanAddedTodos — ordering and caps', () => {
    it('ranks FIXME and HACK above TODO, so the cap keeps the urgent ones', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -1 +1,4 @@',
            '+// TODO: later',
            '+// HACK: works for now',
            '+// FIXME: this is wrong',
        ].join('\n')));
        expect(items.map(i => i.keyword)).toEqual(['FIXME', 'HACK', 'TODO']);
    });

    it('caps the list but reports the true total', () => {
        const lines = ['@@ -1 +1,40 @@'];
        for (let i = 0; i < 30; i++) lines.push(`+// TODO: item ${i}`);
        const scan = scanAddedTodos(pr(lines.join('\n')), { maxItems: 5 });
        expect(scan.items).toHaveLength(5);
        expect(scan.total).toBe(30);
    });

    it('clips a very long note', () => {
        const long = 'x'.repeat(400);
        const { items } = scanAddedTodos(pr(`@@ -1 +1,2 @@\n+// TODO: ${long}`));
        expect(items[0].note.length).toBeLessThanOrEqual(TODO_DEFAULTS.maxNoteChars);
    });

    it('tracks line numbers correctly across multiple hunks', () => {
        const { items } = scanAddedTodos(pr([
            '@@ -1,2 +1,3 @@',
            ' a',
            '+// TODO: first',
            '@@ -50,2 +60,3 @@',
            ' b',
            '+// TODO: second',
        ].join('\n')));
        const first = items.find(i => i.note === 'first');
        const second = items.find(i => i.note === 'second');
        expect(first.line).toBe(2);
        expect(second.line).toBe(61);
    });
});

describe('renderTodoSection', () => {
    it('renders nothing when there are no markers', () => {
        expect(renderTodoSection({ items: [], total: 0 })).toBe('');
        expect(renderTodoSection(null)).toBe('');
    });

    it('lists markers with locations and flags untracked ones', () => {
        const scan = scanAddedTodos(pr([
            '@@ -1 +1,3 @@',
            '+// TODO: PROJ-9 tracked one',
            '+// FIXME: untracked one',
        ].join('\n')));
        const out = renderTodoSection(scan);

        expect(out).toContain('### Markers added by this PR');
        expect(out).toContain('**FIXME**');
        expect(out).toContain('`src/a.js:2`');
        expect(out).toMatch(/1 of these reference no ticket/);
    });

    it('notes the overflow when capped', () => {
        const lines = ['@@ -1 +1,20 @@'];
        for (let i = 0; i < 12; i++) lines.push(`+// TODO: item ${i}`);
        const out = renderTodoSection(scanAddedTodos(pr(lines.join('\n')), { maxItems: 3 }));
        expect(out).toContain('…and 9 more');
    });
});

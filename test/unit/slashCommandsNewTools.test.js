/**
 * The new commands' argument handling. `/ask-line` is the only one with a custom
 * split, and it is the one that can go wrong quietly: a mis-split turns part of
 * the question into part of the file path, and the tool then refuses a file the
 * PR obviously changed.
 */

const { SlashCommandParser } = require('../../src/services/SlashCommandParser.js');

const TAB = 'https://github.com/acme/widgets/pull/42';

function build(input) {
    const parsed = SlashCommandParser.parse(input);
    if (!parsed?.valid) return { parsed, payload: null };
    return { parsed, payload: SlashCommandParser.buildPayload(parsed, { tabUrl: TAB }) };
}

describe('/labels', () => {
    it('suggests without applying by default', () => {
        const { payload } = build('/labels');
        expect(payload.messageType).toBe('GENERATE_PR_LABELS');
        expect(payload.payload).toEqual({ prUrl: TAB, apply: false });
    });

    it('applies only when explicitly asked', () => {
        // A read command must not write because the user typed a word.
        const { payload } = build('/labels apply');
        expect(payload.payload.apply).toBe(true);
        expect(payload.displayMessage).toMatch(/applying/i);
    });

    it('does not treat an unknown word as apply', () => {
        const { payload } = build('/labels please');
        expect(payload.payload.apply).toBe(false);
    });
});

describe('/add-docs', () => {
    it('targets the current PR', () => {
        const { payload } = build('/add-docs');
        expect(payload.messageType).toBe('GENERATE_DOCSTRINGS');
        expect(payload.payload).toEqual({ prUrl: TAB });
    });
});

describe('/ask-line', () => {
    it('splits the target from the question at the first space', () => {
        const { payload } = build('/ask-line src/users.js:214 why is this catching Exception?');
        expect(payload.messageType).toBe('ASK_LINE_QUESTION');
        expect(payload.payload.target).toBe('src/users.js:214');
        expect(payload.payload.question).toBe('why is this catching Exception?');
    });

    it('keeps a question containing a colon intact', () => {
        // The naive split (on ':') would put "why" into the file path.
        const { payload } = build('/ask-line a/b.js:9 why: is this here');
        expect(payload.payload.target).toBe('a/b.js:9');
        expect(payload.payload.question).toBe('why: is this here');
    });

    it('yields an empty question when only a target was given', () => {
        // The handler rejects this with a usage message rather than guessing.
        const { payload } = build('/ask-line src/a.js:1');
        expect(payload.payload.target).toBe('src/a.js:1');
        expect(payload.payload.question).toBe('');
    });

    it('is invalid with no argument at all', () => {
        const { parsed } = build('/ask-line');
        expect(parsed.valid).toBe(false);
    });

    it('tolerates extra whitespace between target and question', () => {
        const { payload } = build('/ask-line src/a.js:1    why?');
        expect(payload.payload.target).toBe('src/a.js:1');
        expect(payload.payload.question).toBe('why?');
    });
});

describe('/history', () => {
    it('targets the current PR', () => {
        const { payload } = build('/history');
        expect(payload.messageType).toBe('PRIOR_REVIEW_HISTORY');
        expect(payload.payload).toEqual({ prUrl: TAB });
    });
});

describe('discoverability', () => {
    it('lists every new command in help', () => {
        // A command absent from /help is a command nobody finds.
        const help = JSON.stringify(SlashCommandParser.getHelpText());
        for (const cmd of ['/labels', '/add-docs', '/ask-line', '/history']) {
            expect(help).toContain(cmd);
        }
    });
});

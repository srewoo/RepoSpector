/**
 * `doExportContext` wraps each hunk's raw text in a markdown fence. A hunk
 * is sliced from a stored patch — arbitrary file content — so it can itself
 * contain a literal ``` sequence (confirmed present in this corpus, in two
 * `.expect.md` fixture patches under facebook/react#34000). A hard-coded
 * ``` fence would be closed early by that content, misaligning every
 * finding rendered after it in a worksheet a human is using to produce
 * real verdicts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mdFence, doExportContext } = require('../../eval/adjudicate.js');

describe('mdFence', () => {
    it('returns the minimum 3-backtick fence for plain content', () => {
        expect(mdFence('no backticks here')).toBe('```');
    });

    it('returns a fence longer than a literal ``` run inside the content', () => {
        const fence = mdFence('before\n```\nafter');
        expect(fence.length).toBeGreaterThan(3);
        expect(fence).toBe('````');
    });

    it('returns a fence longer than the longest of several runs', () => {
        const fence = mdFence('short ``` and long `````` run');
        expect(fence.length).toBe(7); // longest run is 6 backticks
    });
});

describe('doExportContext fence safety (integration)', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adjudicate-fence-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps a hunk containing a literal ``` sequence inside a single fenced block', () => {
        const trickyPatch = [
            '@@ -1,3 +1,4 @@',
            ' context',
            '+here is a fixture snippet:',
            '+```',
            '+embedded code fence',
            '+```',
            ' more context',
        ].join('\n');

        const corpus = {
            cases: [
                {
                    id: 'test/repo#1',
                    prData: { files: [{ filename: 'fixture.md', patch: trickyPatch }] },
                    predictions: [
                        {
                            file: 'fixture.md',
                            line: 2,
                            severity: 'low',
                            title: 'test finding',
                            description: 'test description',
                            suggestion: 'test suggestion',
                            rule: 'test/rule',
                            posted: true,
                        },
                    ],
                    adjudications: [],
                },
            ],
        };

        const corpusPath = path.join(dir, 'corpus.json');
        const outPath = path.join(dir, 'worksheet.md');
        fs.writeFileSync(corpusPath, JSON.stringify(corpus));

        doExportContext({ corpus: corpusPath, exportContext: outPath, postedOnly: false });

        const out = fs.readFileSync(outPath, 'utf8');

        // The chosen fence must not itself be a run of exactly 3 backticks,
        // since the content contains a 3-backtick run.
        const fenceLines = out.split('\n').filter(l => /^`{3,}(diff)?$/.test(l));
        expect(fenceLines.length).toBeGreaterThanOrEqual(2);
        const openFence = fenceLines[0].replace('diff', '');
        expect(openFence.length).toBeGreaterThan(3);

        // The whole hunk, including its embedded ``` lines, must appear
        // between the open and close fence as one contiguous block.
        expect(out).toContain('embedded code fence');
        const start = out.indexOf(`${openFence}diff`);
        const bodyStart = start + `${openFence}diff`.length;
        const end = out.indexOf(openFence, bodyStart);
        const body = out.slice(bodyStart, end);
        expect(body).toContain('```');
        expect(body).toContain('embedded code fence');
    });
});

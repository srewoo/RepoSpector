/**
 * Evidence-anchored positioning — the check that a finding lands where the code
 * it quoted actually is, not where the model said it was.
 */
const { anchorFindings, locateInHunks } = require('../../src/utils/anchorFindings.js');
const { parsePatchHunks } = require('../../src/utils/patchLines.js');

const PATCH = [
    '@@ -10,4 +10,6 @@ def handler(req):',
    ' def handler(req):',
    '-    ts = req.get("ts")',
    '+    ts = req.get("ts", 0)',
    '+    created = datetime.utcfromtimestamp(ts)',
    '     return created',
].join('\n');

const OTHER = [
    '@@ -1,2 +1,3 @@',
    ' import os',
    '+SECRET = os.environ["TOKEN"]',
].join('\n');

const files = [
    { newPath: 'app/handler.py', hunks: parsePatchHunks(PATCH) },
    { newPath: 'app/config.py', hunks: parsePatchHunks(OTHER) },
];

describe('anchorFindings', () => {
    it('corrects a drifted line number from the quoted evidence', () => {
        const { findings, stats } = anchorFindings(
            [{ file: 'app/handler.py', line: 7, evidence: '    created = datetime.utcfromtimestamp(ts)' }],
            files,
        );
        expect(findings[0].line).toBe(12);
        expect(findings[0].anchor).toBe('exact');
        expect(stats.moved).toBe(1);
    });

    it('matches multi-line evidence and reports the full span', () => {
        const { findings } = anchorFindings(
            [{
                file: 'app/handler.py',
                evidence: 'ts = req.get("ts", 0)\ncreated = datetime.utcfromtimestamp(ts)',
            }],
            files,
        );
        expect(findings[0].line).toBe(11);
        expect(findings[0].endLine).toBe(12);
    });

    it('re-files a finding whose evidence lives in another changed file', () => {
        const { findings, stats } = anchorFindings(
            [{ file: 'app/handler.py', line: 2, evidence: 'SECRET = os.environ["TOKEN"]' }],
            files,
        );
        expect(findings[0].file).toBe('app/config.py');
        expect(findings[0].line).toBe(2);
        expect(findings[0].anchor).toBe('relocated');
        expect(stats.relocated).toBe(1);
    });

    it('matches a line the change deleted, on the old side', () => {
        const hit = locateInHunks('ts = req.get("ts")', files[0].hunks);
        expect(hit.start).toBe(11);
    });

    it('leaves an unmatched finding untouched rather than guessing', () => {
        const { findings, stats } = anchorFindings(
            [{ file: 'app/handler.py', line: 99, evidence: 'nothing_like_this()' }],
            files,
        );
        expect(findings[0].line).toBe(99);
        expect(findings[0].anchor).toBe('unmatched');
        expect(stats.unmatched).toBe(1);
    });

    it('flags a finding that quoted no code, and keeps it', () => {
        const { findings, stats } = anchorFindings(
            [{ file: 'app/handler.py', line: 12, title: 'vague' }],
            files,
        );
        expect(findings[0].line).toBe(12);
        expect(stats.unevidenced).toBe(1);
    });

    it('is whitespace-insensitive but not content-insensitive', () => {
        const { findings } = anchorFindings(
            [{ file: 'app/handler.py', evidence: 'created   =  datetime.utcfromtimestamp(ts)' }],
            files,
        );
        expect(findings[0].line).toBe(12);
    });
});

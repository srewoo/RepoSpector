/**
 * These renderers exist because the policies they describe were previously
 * reported only to `console.log` and to `reviewQuality` — neither of which the
 * person the review is written for ever reads. So the tests are about what
 * reaches the summary, and about the asymmetry that matters most: a source that
 * FAILED must be louder than one that found nothing.
 */

const {
    renderExternalSection,
    renderProvenanceNote,
    renderContextNote,
} = require('../../src/utils/reviewProvenance.js');

describe('renderExternalSection', () => {
    it('attributes findings to the tools that produced them', () => {
        const md = renderExternalSection({
            sources: [{ name: 'codeql.sarif', ok: true, findings: 3, tools: ['CodeQL'] }],
            stats: { ok: 1, failed: 0 },
        });
        expect(md).toContain('From your own scanners');
        expect(md).toContain('CodeQL');
        expect(md).toMatch(/not from this review's model/);
    });

    it('names a source it could not read', () => {
        // A review that silently lost its CodeQL findings looks identical to one
        // where CodeQL found nothing — and the second is a far stronger claim.
        const md = renderExternalSection({
            sources: [{ name: 'gl-sast-report.json', ok: false, error: 'Artifact not found (404)' }],
            stats: { ok: 0, failed: 1 },
        });
        expect(md).toContain('unavailable');
        expect(md).toContain('gl-sast-report.json');
        expect(md).toContain('404');
    });

    it('reports both when one source worked and another did not', () => {
        const md = renderExternalSection({
            sources: [
                { name: 'semgrep.sarif', ok: true, findings: 2, tools: ['Semgrep'] },
                { name: 'trivy.sarif', ok: false, error: 'malformed' },
            ],
            stats: { ok: 1, failed: 1 },
        });
        expect(md).toContain('Semgrep');
        expect(md).toContain('trivy.sarif');
        expect(md).not.toContain('unavailable'); // something DID come through
    });

    it('says nothing when a source was read and found nothing', () => {
        // Zero findings from a working scanner is not worth a section; it is
        // covered by the review finding nothing.
        const md = renderExternalSection({
            sources: [{ name: 'codeql.sarif', ok: true, findings: 0, tools: ['CodeQL'] }],
            stats: { ok: 1, failed: 0 },
        });
        expect(md).toBe('');
    });

    it('is empty when no source was consulted at all', () => {
        expect(renderExternalSection(null)).toBe('');
        expect(renderExternalSection({ sources: [] })).toBe('');
    });
});

describe('renderProvenanceNote', () => {
    it('states the scope the review held itself to', () => {
        // The promise that justified naming the filter mode in the first place.
        const md = renderProvenanceNote({
            filterModeNote: 'Findings scoped to lines this PR added.',
        });
        expect(md).toContain('Findings scoped to lines this PR added');
        expect(md).toMatch(/^<sub>/);
    });

    it('derives the scope from stats when no note was recorded', () => {
        const md = renderProvenanceNote({
            filterMode: { mode: 'added', droppedOutsideDiff: 2, droppedUnknownFile: 0, relocated: 1 },
        });
        expect(md).toContain('lines this PR added');
        expect(md).toContain('2 finding(s) outside that scope');
    });

    it('explains the merge gate', () => {
        const md = renderProvenanceNote({
            failLevelNote: 'Merge gate: passed — no finding at or above high (threshold: high).',
        });
        expect(md).toContain('Merge gate: passed');
    });

    it('mentions the call ceiling only when it got in the way', () => {
        const hit = renderProvenanceNote({ callBudgetNote: 'Call budget reached (60/60) — skipped: scoring.' });
        expect(hit).toContain('Call budget reached');

        const clear = renderProvenanceNote({ callBudgetNote: null, filterModeNote: 'x.' });
        expect(clear).not.toContain('Call budget');
    });

    it('says which settings an organization pinned', () => {
        // A reviewer who turned something on and saw nothing happen should find
        // out why here, not by reading the source.
        const md = renderProvenanceNote({ configEnforced: ['failLevel', 'enablePostInlineComments'] });
        expect(md).toContain('`failLevel`, `enablePostInlineComments`');
        expect(md).toContain('organization policy');
    });

    it('joins several statements into one line', () => {
        const md = renderProvenanceNote({
            filterModeNote: 'Findings scoped to lines this PR added.',
            failLevelNote: 'Merge gate: passed — no finding at or above high (threshold: high).',
        });
        expect(md.match(/<sub>/g)).toHaveLength(1);
        expect(md).toContain(' · ');
    });

    it('is empty when there is nothing to say', () => {
        expect(renderProvenanceNote({})).toBe('');
        expect(renderProvenanceNote(null)).toBe('');
    });
});

describe('renderContextNote', () => {
    it('warns when the review ran without repository context', () => {
        const md = renderContextNote({ repoContextAvailable: false });
        expect(md).toContain('without repository context');
        expect(md).toContain('⚠️');
    });

    it('reports findings about files outside the PR', () => {
        const md = renderContextNote({ filterMode: { droppedUnknownFile: 3 } });
        expect(md).toContain('3 finding(s) referenced files outside this PR');
    });

    it('reports unreadable scanner sources', () => {
        const md = renderContextNote({ externalFindings: { stats: { failed: 2 } } });
        expect(md).toContain('2 external scanner source(s) unreadable');
    });

    it('stays silent when the review had everything', () => {
        expect(renderContextNote({ repoContextAvailable: true })).toBe('');
        expect(renderContextNote({})).toBe('');
        expect(renderContextNote(null)).toBe('');
    });
});

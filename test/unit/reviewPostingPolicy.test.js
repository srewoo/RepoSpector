const {
    partitionForPosting,
    renderDeferredSections,
    renderPolicyNote,
    postingSeverity,
} = require('../../src/utils/reviewPostingPolicy.js');

const f = (over = {}) => ({
    file: 'src/a.js',
    line: 10,
    severity: 'high',
    title: 'Something',
    ...over,
});

describe('postingSeverity', () => {
    it('collapses canonical, legacy and LLM-ish severities into three buckets', () => {
        expect(postingSeverity({ severity: 'blocking' })).toBe('blocking');
        expect(postingSeverity({ severity: 'critical' })).toBe('blocking');
        expect(postingSeverity({ severity: 'high' })).toBe('blocking');
        expect(postingSeverity({ severity: 'error' })).toBe('blocking');

        expect(postingSeverity({ severity: 'medium' })).toBe('suggestion');
        expect(postingSeverity({ severity: 'warning' })).toBe('suggestion');

        expect(postingSeverity({ severity: 'low' })).toBe('nitpick');
        expect(postingSeverity({ severity: 'info' })).toBe('nitpick');
    });

    it('defaults unknown severity to suggestion, not blocking', () => {
        expect(postingSeverity({ severity: 'wat' })).toBe('suggestion');
        expect(postingSeverity({})).toBe('suggestion');
    });
});

describe('partitionForPosting — the findings policy', () => {
    it('posts only blocking findings inline', () => {
        const { inline, suggestions, nitpicks } = partitionForPosting([
            f({ severity: 'critical', title: 'RCE' }),
            f({ severity: 'medium', title: 'naming', line: 11 }),
            f({ severity: 'low', title: 'nit', line: 12 }),
        ]);

        expect(inline).toHaveLength(1);
        expect(inline[0].title).toBe('RCE');
        expect(suggestions.map(s => s.title)).toEqual(['naming']);
        expect(nitpicks.map(s => s.title)).toEqual(['nit']);
    });

    it('returns zero inline comments when nothing is blocking', () => {
        const { inline, stats } = partitionForPosting([
            f({ severity: 'medium' }),
            f({ severity: 'low', line: 11 }),
        ]);
        expect(inline).toHaveLength(0);
        expect(stats.demotedToSummary).toBe(2);
    });

    it('demotes rather than drops a blocking finding with no location', () => {
        const { inline, suggestions } = partitionForPosting([
            f({ severity: 'blocking', file: null, line: null, title: 'architectural' }),
        ]);
        expect(inline).toHaveLength(0);
        expect(suggestions.map(s => s.title)).toEqual(['architectural']);
    });

    it('demotes overflow past maxInline instead of discarding it', () => {
        const many = Array.from({ length: 5 }, (_, i) =>
            f({ severity: 'high', line: i + 1, title: `b${i}` }));
        const { inline, suggestions, stats } = partitionForPosting(many, { maxInline: 2 });

        expect(inline).toHaveLength(2);
        expect(stats.cappedFromInline).toBe(3);
        expect(suggestions).toHaveLength(3);
    });

    it('applies the severity floor before partitioning, so floored findings do not resurface in the summary', () => {
        const { inline, suggestions, nitpicks, stats } = partitionForPosting([
            f({ severity: 'critical' }),
            f({ severity: 'medium', line: 11 }),
            f({ severity: 'low', line: 12 }),
        ], { severityThreshold: 'high' });

        expect(inline).toHaveLength(1);
        expect(suggestions).toHaveLength(0);
        expect(nitpicks).toHaveLength(0);
        expect(stats.droppedBySeverityFloor).toBe(2);
    });

    it("treats a severityThreshold of 'all' as no floor", () => {
        const { stats } = partitionForPosting([f({ severity: 'low' })], { severityThreshold: 'all' });
        expect(stats.droppedBySeverityFloor).toBe(0);
    });

    it('drops findings below minConfidence but keeps findings with no confidence at all', () => {
        const { inline, stats } = partitionForPosting([
            f({ severity: 'high', confidence: 0.2, title: 'unsure' }),
            f({ severity: 'high', confidence: 0.9, line: 11, title: 'sure' }),
            f({ severity: 'high', line: 12, title: 'no-confidence-field' }),
        ], { minConfidence: 0.5 });

        expect(stats.droppedByConfidence).toBe(1);
        expect(inline.map(i => i.title).sort()).toEqual(['no-confidence-field', 'sure']);
    });

    it('accepts confidence expressed as a percentage', () => {
        const { stats } = partitionForPosting([f({ confidence: 90, severity: 'high' })], { minConfidence: 0.5 });
        expect(stats.droppedByConfidence).toBe(0);
    });

    it('lifts per-file engine containers before partitioning', () => {
        const { inline } = partitionForPosting([
            { file: 'src/b.js', findings: [{ line: 3, severity: 'critical', title: 'nested' }] },
        ]);
        expect(inline).toHaveLength(1);
        expect(inline[0].file).toBe('src/b.js');
    });

    it('restores post-everything behaviour when blockingOnlyInline is false', () => {
        const { inline, suggestions } = partitionForPosting([
            f({ severity: 'critical' }),
            f({ severity: 'low', line: 11 }),
        ], { blockingOnlyInline: false });

        expect(inline).toHaveLength(2);
        expect(suggestions).toHaveLength(0);
    });
});

describe('renderDeferredSections', () => {
    it('renders nothing when there is nothing to defer', () => {
        expect(renderDeferredSections([], [])).toBe('');
    });

    it('renders path:line bullets under explicit headings', () => {
        const md = renderDeferredSections(
            [f({ severity: 'medium', title: 'use the bgcolor token', line: 42 })],
            [f({ severity: 'low', title: 'unclear name', line: 91, rule: 'naming' })],
        );
        expect(md).toContain('### Suggestions');
        expect(md).toContain('`src/a.js:42`');
        expect(md).toContain('use the bgcolor token');
        expect(md).toContain('### Nitpicks');
        expect(md).toContain('`naming`');
    });

    it('caps each section and says how many were withheld', () => {
        const many = Array.from({ length: 45 }, (_, i) => f({ title: `s${i}`, line: i }));
        const md = renderDeferredSections(many, [], { maxPerSection: 40 });
        expect(md).toContain('…and 5 more');
    });
});

describe('renderPolicyNote', () => {
    it('is empty when the policy changed nothing', () => {
        expect(renderPolicyNote({ demotedToSummary: 0, droppedBySeverityFloor: 0 })).toBe('');
    });

    it('explains the silence when findings were demoted or dropped', () => {
        const note = renderPolicyNote({
            demotedToSummary: 3,
            droppedBySeverityFloor: 1,
            suppressedAsDuplicate: 2,
        });
        expect(note).toContain('3 non-blocking');
        expect(note).toContain('1 below the configured severity floor');
        expect(note).toContain('2 already commented on');
    });
});

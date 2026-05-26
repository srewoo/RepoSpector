const {
    PHASE,
    SEVERITY,
    VERDICT,
    CATEGORY,
    toCanonicalFinding,
    rollupVerdict,
    buildVerdictReport,
    partitionByPhase,
    makeFindingId,
} = require('../../src/services/reviewSchema.js');

describe('reviewSchema', () => {
    describe('toCanonicalFinding', () => {
        it('should lift a legacy LLM finding into the canonical shape', () => {
            const legacy = {
                severity: 'critical',
                type: 'security',
                title: 'SQL injection',
                message: 'Unparameterized query at line 42',
                file: 'src/db/users.js',
                line: '42',
                codeSnippet: 'db.query("SELECT * FROM u WHERE id=" + id)',
            };
            const f = toCanonicalFinding(legacy);
            expect(f.severity).toBe(SEVERITY.BLOCKING);
            expect(f.phase).toBe(PHASE.DEEP);
            expect(f.category).toBe('security');
            expect(f.file).toBe('src/db/users.js');
            expect(f.line).toBe(42);
            expect(f.evidence).toContain('SELECT *');
            expect(f.suggestion).toContain('Unparameterized');
            expect(f.id).toMatch(/^f_/);
        });

        it('should default unknown severity to suggestion', () => {
            const f = toCanonicalFinding({ severity: 'banana' });
            expect(f.severity).toBe(SEVERITY.SUGGESTION);
        });

        it('should apply defaults for missing fields', () => {
            const f = toCanonicalFinding(
                { suggestion: 'tighten this loop' },
                { phase: PHASE.STANDARDS, source: 'eslint', category: CATEGORY.LINT },
            );
            expect(f.phase).toBe(PHASE.STANDARDS);
            expect(f.source).toBe('eslint');
            expect(f.category).toBe(CATEGORY.LINT);
        });

        it('should reject bad line numbers', () => {
            expect(toCanonicalFinding({ line: 'abc' }).line).toBeNull();
            expect(toCanonicalFinding({ line: -5 }).line).toBeNull();
            expect(toCanonicalFinding({ line: 0 }).line).toBeNull();
            expect(toCanonicalFinding({ line: '17' }).line).toBe(17);
        });

        it('should return null on garbage input', () => {
            expect(toCanonicalFinding(null)).toBeNull();
            expect(toCanonicalFinding('a string')).toBeNull();
        });
    });

    describe('rollupVerdict', () => {
        it('returns APPROVE on empty findings', () => {
            expect(rollupVerdict([])).toBe(VERDICT.APPROVE);
        });
        it('returns BLOCK when any blocking finding present', () => {
            const findings = [
                { severity: SEVERITY.NITPICK },
                { severity: SEVERITY.BLOCKING },
                { severity: SEVERITY.SUGGESTION },
            ];
            expect(rollupVerdict(findings)).toBe(VERDICT.BLOCK);
        });
        it('returns NEEDS_DISCUSSION when suggestions but no blockers', () => {
            const findings = [
                { severity: SEVERITY.NITPICK },
                { severity: SEVERITY.SUGGESTION },
            ];
            expect(rollupVerdict(findings)).toBe(VERDICT.NEEDS_DISCUSSION);
        });
        it('returns APPROVE when only nitpicks', () => {
            expect(rollupVerdict([{ severity: SEVERITY.NITPICK }])).toBe(VERDICT.APPROVE);
        });
    });

    describe('buildVerdictReport', () => {
        it('produces a complete report from raw findings', () => {
            const report = buildVerdictReport({
                findings: [
                    { severity: 'high', title: 'XSS', file: 'a.js', line: 10, phase: PHASE.DEEP },
                    { severity: 'low', title: 'style', file: 'b.js', line: 2, phase: PHASE.STANDARDS },
                ],
                summary: { deep: 'one critical issue', standards: 'minor style' },
                meta: { mrUrl: 'https://example/mr/1' },
            });
            expect(report.schemaVersion).toBe(1);
            expect(report.verdict).toBe(VERDICT.BLOCK);
            expect(report.findings).toHaveLength(2);
            expect(report.counts.blocking).toBe(1);
            expect(report.counts.nitpick).toBe(1);
            expect(report.counts.total).toBe(2);
            expect(report.summary.deep).toMatch(/critical/);
            expect(report.meta.mrUrl).toBeDefined();
            expect(report.meta.generatedAt).toBeDefined();
        });

        it('honours override verdict for skip-rules', () => {
            const r = buildVerdictReport({ findings: [], override: VERDICT.SKIP });
            expect(r.verdict).toBe(VERDICT.SKIP);
        });
    });

    describe('partitionByPhase', () => {
        it('splits findings into deep + standards buckets', () => {
            const findings = [
                { phase: PHASE.DEEP, id: 1 },
                { phase: PHASE.STANDARDS, id: 2 },
                { phase: PHASE.DEEP, id: 3 },
            ];
            const { deep, standards } = partitionByPhase(findings);
            expect(deep.map((f) => f.id)).toEqual([1, 3]);
            expect(standards.map((f) => f.id)).toEqual([2]);
        });
    });

    describe('makeFindingId', () => {
        it('produces unique-ish ids', () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) ids.add(makeFindingId());
            expect(ids.size).toBe(100);
        });
    });
});

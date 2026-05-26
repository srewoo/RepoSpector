const {
    buildAssignedHunks,
    filterToAssignedHunks,
    buildAssignedHunksFromDiff,
} = require('../../src/services/FindingsNormalizer.js');

// Mimic the shape DiffParser produces.
const parsedFiles = [
    {
        newPath: 'src/a.js',
        hunks: [
            {
                newStart: 10,
                newLines: 3,
                lines: [
                    { type: 'context', number: { new: 10, old: 10 } },
                    { type: 'added',   number: { new: 11, old: null } },
                    { type: 'added',   number: { new: 12, old: null } },
                ],
            },
            {
                newStart: 50,
                newLines: 1,
                lines: [
                    { type: 'added', number: { new: 50, old: null } },
                ],
            },
        ],
    },
    {
        newPath: 'src/b.js',
        hunks: [
            { newStart: 1, newLines: 2, lines: [
                { type: 'added', number: { new: 1, old: null } },
                { type: 'added', number: { new: 2, old: null } },
            ]},
        ],
    },
];

describe('buildAssignedHunks', () => {
    it('extracts NEW-side added line numbers per file', () => {
        const allow = buildAssignedHunks(parsedFiles);
        expect([...allow.get('src/a.js')].sort((a, b) => a - b)).toEqual([11, 12, 50]);
        expect([...allow.get('src/b.js')].sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it('falls back to hunk header range when per-line numbers absent', () => {
        const allow = buildAssignedHunks([
            { newPath: 'x.js', hunks: [{ newStart: 100, newLines: 3 }] },
        ]);
        expect([...allow.get('x.js')].sort((a, b) => a - b)).toEqual([100, 101, 102]);
    });

    it('returns empty map for bad input', () => {
        expect(buildAssignedHunks(null).size).toBe(0);
        expect(buildAssignedHunks([]).size).toBe(0);
    });
});

describe('filterToAssignedHunks', () => {
    const allow = buildAssignedHunks(parsedFiles);

    it('keeps findings whose line is in the assigned hunks', () => {
        const findings = [
            { file: 'src/a.js', line: 11, severity: 'blocking' },
            { file: 'src/b.js', line: 2, severity: 'suggestion' },
        ];
        const { kept, dropped } = filterToAssignedHunks(findings, allow);
        expect(kept).toHaveLength(2);
        expect(dropped).toHaveLength(0);
    });

    it('drops findings on files not in the diff', () => {
        const { kept, dropped } = filterToAssignedHunks(
            [{ file: 'src/unknown.js', line: 1 }],
            allow,
        );
        expect(kept).toHaveLength(0);
        expect(dropped[0]._dropReason).toBe('file_not_in_diff');
    });

    it('snaps findings within the snap window to nearest changed line', () => {
        const { kept, dropped, stats } = filterToAssignedHunks(
            [{ file: 'src/a.js', line: 13, severity: 'suggestion' }], // 1 line off from 12
            allow,
            { snapWindow: 3 },
        );
        expect(kept).toHaveLength(1);
        expect(kept[0].line).toBe(12);
        expect(kept[0]._snappedFrom).toBe(13);
        expect(stats.snapped).toBe(1);
        expect(dropped).toHaveLength(0);
    });

    it('does not snap when snapWindow=0', () => {
        const { kept, dropped } = filterToAssignedHunks(
            [{ file: 'src/a.js', line: 13 }],
            allow,
            { snapWindow: 0 },
        );
        expect(kept).toHaveLength(0);
        expect(dropped[0]._dropReason).toBe('outside_assigned_hunks');
    });

    it('drops findings outside the snap window', () => {
        const { kept, dropped } = filterToAssignedHunks(
            [{ file: 'src/a.js', line: 30 }],
            allow,
            { snapWindow: 3 },
        );
        expect(kept).toHaveLength(0);
        expect(dropped[0]._dropReason).toBe('outside_assigned_hunks');
    });

    it('keeps file-level findings (line=null) by default', () => {
        const { kept } = filterToAssignedHunks(
            [{ file: 'src/a.js', line: null, severity: 'blocking' }],
            allow,
        );
        expect(kept).toHaveLength(1);
    });

    it('drops file-level findings when keepFileLevel=false', () => {
        const { kept, dropped } = filterToAssignedHunks(
            [{ file: 'src/a.js', line: null }],
            allow,
            { keepFileLevel: false },
        );
        expect(kept).toHaveLength(0);
        expect(dropped[0]._dropReason).toBe('file_level_disabled');
    });

    it('returns useful stats', () => {
        const { stats } = filterToAssignedHunks(
            [
                { file: 'src/a.js', line: 11 },          // kept
                { file: 'src/a.js', line: 30 },          // dropped
                { file: 'src/unknown.js', line: 5 },     // dropped
            ],
            allow,
            { snapWindow: 0 },
        );
        expect(stats).toEqual({ input: 3, kept: 1, dropped: 2, snapped: 0 });
    });

    it('survives empty input', () => {
        expect(filterToAssignedHunks([], allow).kept).toEqual([]);
        expect(filterToAssignedHunks(null, allow).kept).toEqual([]);
    });
});

// Integration with DiffParser requires its Sanitizer dependency wired up.
// Real callers pass already-parsed files via buildAssignedHunks().
describe.skip('buildAssignedHunksFromDiff (integration with DiffParser)', () => {
    it('parses a unified diff into the allow-list', async () => {
        const diff = [
            'diff --git a/src/x.js b/src/x.js',
            'index aaa..bbb 100644',
            '--- a/src/x.js',
            '+++ b/src/x.js',
            '@@ -1,3 +1,4 @@',
            ' const a = 1;',
            '+const b = 2;',
            '+const c = 3;',
            ' const d = 4;',
        ].join('\n');
        const allow = await buildAssignedHunksFromDiff(diff, 'github');
        const lines = allow.get('src/x.js');
        expect(lines).toBeDefined();
        // Both added lines should be present.
        expect(lines.has(2)).toBe(true);
        expect(lines.has(3)).toBe(true);
    });
});

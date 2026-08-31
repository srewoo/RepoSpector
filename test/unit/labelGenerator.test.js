/**
 * Labels are deterministic here, which is the whole claim: the same commit must
 * produce the same labels, every label must be traceable to the files that
 * caused it, and applying them must never delete a human's own labels.
 */

const { LabelGeneratorService } = require('../../src/services/LabelGeneratorService.js');

function pr(files, extra = {}) {
    return {
        title: 'Some change',
        files: files.map(f => ({ additions: 5, deletions: 1, ...f })),
        ...extra,
    };
}

const svc = () => new LabelGeneratorService();

describe('size labels', () => {
    it('buckets by total changed lines', () => {
        const cases = [
            [{ additions: 3, deletions: 2 }, 'size/XS'],
            [{ additions: 30, deletions: 5 }, 'size/S'],
            [{ additions: 100, deletions: 50 }, 'size/M'],
            [{ additions: 400, deletions: 100 }, 'size/L'],
            [{ additions: 2000, deletions: 10 }, 'size/XL'],
        ];
        for (const [churn, expected] of cases) {
            const { labels } = svc().generate({
                prData: pr([{ filename: 'src/a.js', ...churn }]),
            });
            expect(labels).toContain(expected);
        }
    });

    it('emits no size label for an empty file list', () => {
        const { labels } = svc().generate({ prData: pr([]) });
        expect(labels).toEqual([]);
    });
});

describe('what the diff touches', () => {
    it('labels tests, and flags production code that ships without them', () => {
        const withTests = svc().generate({
            prData: pr([{ filename: 'src/a.js' }, { filename: 'src/a.test.js' }]),
        });
        expect(withTests.labels).toContain('tests');
        expect(withTests.labels).not.toContain('needs-tests');

        const without = svc().generate({ prData: pr([{ filename: 'src/a.js' }]) });
        expect(without.labels).toContain('needs-tests');
    });

    it('does not ask a docs-only PR for tests', () => {
        const { labels } = svc().generate({ prData: pr([{ filename: 'README.md' }]) });
        expect(labels).not.toContain('needs-tests');
        expect(labels).toContain('documentation');
    });

    it('recognises migrations, dependencies, CI, infra and API surfaces', () => {
        const { labels } = svc().generate({
            prData: pr([
                { filename: 'db/migrations/003_add_col.sql' },
                { filename: 'package-lock.json' },
                { filename: '.github/workflows/ci.yml' },
                { filename: 'terraform/main.tf' },
                { filename: 'api/openapi.yaml' },
            ]),
        });
        for (const l of ['database', 'dependencies', 'ci', 'infrastructure', 'api']) {
            expect(labels).toContain(l);
        }
    });

    it('flags a migration with no rollback', () => {
        const noDown = svc().generate({
            prData: pr([{ filename: 'migrations/004.sql', patch: '@@ -0,0 +1 @@\n+ALTER TABLE users ADD COLUMN x int;' }]),
        });
        expect(noDown.labels).toContain('migration/no-rollback');

        const withDown = svc().generate({
            prData: pr([{ filename: 'migrations/004.sql', patch: '@@ -0,0 +2 @@\n+-- up\n+ALTER TABLE users ADD COLUMN x int;\n+-- down\n+ALTER TABLE users DROP COLUMN x;' }]),
        });
        expect(withDown.labels).not.toContain('migration/no-rollback');
    });

    it('claims documentation only when EVERY file is documentation', () => {
        const { labels } = svc().generate({
            prData: pr([{ filename: 'README.md' }, { filename: 'src/a.js' }]),
        });
        expect(labels).not.toContain('documentation');
    });
});

describe('risk labels from findings', () => {
    it('reads blocking and security findings', () => {
        const { labels, reasons } = svc().generate({
            prData: pr([{ filename: 'src/a.js' }]),
            findings: [
                { blocking: true, title: 'x' },
                { type: 'security', cwe: 'CWE-79', title: 'y' },
            ],
        });
        expect(labels).toContain('review/blocking');
        expect(labels).toContain('security');
        expect(reasons['review/blocking'][0]).toMatch(/1 blocking/);
    });

    it('adds no risk label when there are no findings', () => {
        const { labels } = svc().generate({ prData: pr([{ filename: 'src/a.js' }]) });
        expect(labels).not.toContain('review/blocking');
        expect(labels).not.toContain('security');
    });
});

describe('custom labels from .repospector.yaml', () => {
    it('matches a path pattern', () => {
        const { labels, reasons } = svc().generate({
            prData: pr([{ filename: 'src/billing/invoice.js' }]),
            customLabels: [{ name: 'team/billing', pattern: '^src/billing/' }],
        });
        expect(labels).toContain('team/billing');
        expect(reasons['team/billing'][0]).toContain('invoice.js');
    });

    it('matches added content when asked to', () => {
        const { labels } = svc().generate({
            prData: pr([{ filename: 'src/a.js', patch: '@@ -1 +1 @@\n+process.env.STRIPE_KEY' }]),
            customLabels: [{ name: 'touches/stripe', pattern: 'STRIPE', target: 'content' }],
        });
        expect(labels).toContain('touches/stripe');
    });

    it('does not match removed lines when targeting content', () => {
        // A label for code the PR DELETED would be actively misleading.
        const { labels } = svc().generate({
            prData: pr([{ filename: 'src/a.js', patch: '@@ -1 +0 @@\n-process.env.STRIPE_KEY' }]),
            customLabels: [{ name: 'touches/stripe', pattern: 'STRIPE', target: 'content' }],
        });
        expect(labels).not.toContain('touches/stripe');
    });

    it('reports an unusable rule instead of dropping it silently', () => {
        const { labels, skipped } = svc().generate({
            prData: pr([{ filename: 'src/a.js' }]),
            customLabels: [
                { name: 'bad/regex', pattern: '([' },
                { name: 'no/pattern' },
                { pattern: '.*' },
            ],
        });
        expect(labels).not.toContain('bad/regex');
        expect(skipped).toHaveLength(3);
        expect(skipped[0].reason).toMatch(/invalid pattern/);
        expect(skipped[1].reason).toMatch(/no `pattern`/);
        expect(skipped[2].label).toBe('(unnamed)');
    });
});

describe('determinism and traceability', () => {
    it('returns the same labels for the same input', () => {
        const input = {
            prData: pr([{ filename: 'src/a.js' }, { filename: 'migrations/1.sql' }]),
            findings: [{ blocking: true }],
        };
        const a = svc().generate(input);
        const b = svc().generate(input);
        expect(a.labels).toEqual(b.labels);
    });

    it('gives every label a reason', () => {
        const { labels, reasons } = svc().generate({
            prData: pr([{ filename: 'src/a.js' }, { filename: 'package.json' }]),
        });
        for (const l of labels) {
            expect(reasons[l].length).toBeGreaterThan(0);
        }
    });

    it('caps how many labels it will emit', () => {
        const { labels } = svc().generate({
            prData: pr([{ filename: 'src/a.js' }]),
            customLabels: Array.from({ length: 30 }, (_, i) => ({ name: `l${i}`, pattern: '.' })),
            options: { maxLabels: 4 },
        });
        expect(labels).toHaveLength(4);
    });
});

describe('apply', () => {
    function fakePrService(existing) {
        return {
            calls: [],
            fetchPullRequest: async () => ({ labels: existing }),
            setLabels: async function (url, labels) { this.calls.push(labels); return { success: true }; },
        };
    }

    it('adds without removing what a human put there', async () => {
        // A tool that quietly deletes a triager's priority/p1 gets turned off.
        const prService = fakePrService(['priority/p1', 'cherry-pick']);
        const gen = new LabelGeneratorService({ pullRequestService: prService });

        const res = await gen.apply('https://github.com/a/b/pull/1', ['size/S', 'tests']);
        expect(res.applied).toEqual(['size/S', 'tests']);
        expect(prService.calls[0]).toEqual(['priority/p1', 'cherry-pick', 'size/S', 'tests']);
    });

    it('does not write when every label is already present', async () => {
        const prService = fakePrService(['size/S']);
        const gen = new LabelGeneratorService({ pullRequestService: prService });

        const res = await gen.apply('https://github.com/a/b/pull/1', ['size/S']);
        expect(res.applied).toEqual([]);
        expect(res.alreadyPresent).toEqual(['size/S']);
        expect(prService.calls).toHaveLength(0);
    });

    it('accepts a pre-fetched label list rather than re-fetching', async () => {
        const prService = fakePrService([]);
        prService.fetchPullRequest = async () => { throw new Error('should not be called'); };
        const gen = new LabelGeneratorService({ pullRequestService: prService });

        const res = await gen.apply('https://github.com/a/b/pull/1', ['tests'], { existing: ['bug'] });
        expect(res.applied).toEqual(['tests']);
        expect(prService.calls[0]).toEqual(['bug', 'tests']);
    });

    it('handles labels given as {name} objects', async () => {
        const prService = fakePrService([{ name: 'bug' }]);
        const gen = new LabelGeneratorService({ pullRequestService: prService });
        const res = await gen.apply('https://github.com/a/b/pull/1', ['tests']);
        expect(res.applied).toEqual(['tests']);
    });

    it('refuses without a service that can write', async () => {
        await expect(new LabelGeneratorService().apply('u', ['x']))
            .rejects.toThrow(/setLabels/);
    });

    it('is a no-op for an empty label set', async () => {
        const prService = fakePrService([]);
        const gen = new LabelGeneratorService({ pullRequestService: prService });
        expect(await gen.apply('u', [])).toEqual({ applied: [], alreadyPresent: [] });
        expect(prService.calls).toHaveLength(0);
    });
});

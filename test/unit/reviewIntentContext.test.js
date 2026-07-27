const {
    extractIssueKeys,
    parseAcceptanceCriteria,
    buildHostContext,
    buildIntentBlock,
} = require('../../src/utils/reviewIntentContext.js');

describe('extractIssueKeys', () => {
    it('finds keys in branch, title and description, branch first', () => {
        const keys = extractIssueKeys({
            branches: { source: 'feature/PROJ-42-add-retry' },
            title: 'ABC-7: fix the thing',
            description: 'related to XYZ-9',
        });
        expect(keys).toEqual(['PROJ-42', 'ABC-7', 'XYZ-9']);
    });

    it('deduplicates a key that appears in several places', () => {
        expect(extractIssueKeys({
            branches: { source: 'PROJ-1-x' },
            title: 'PROJ-1 do it',
        })).toEqual(['PROJ-1']);
    });

    it('ignores identifiers that look like keys but are not tickets', () => {
        const keys = extractIssueKeys({ description: 'fixes CVE-2021-44228 and RFC-2119 compliance' });
        expect(keys).toEqual([]);
    });

    it('returns an empty list when there is nothing to find', () => {
        expect(extractIssueKeys({})).toEqual([]);
        expect(extractIssueKeys(null)).toEqual([]);
    });
});

describe('parseAcceptanceCriteria', () => {
    it('reads a bulleted list under an Acceptance Criteria heading', () => {
        const ac = parseAcceptanceCriteria([
            'Some preamble.',
            '',
            '## Acceptance Criteria',
            '- Retries on 5xx up to 3 times',
            '- Emits a metric on final failure',
            '',
            '## Notes',
            '- not a criterion',
        ].join('\n'));

        expect(ac).toEqual([
            'Retries on 5xx up to 3 times',
            'Emits a metric on final failure',
        ]);
    });

    it('reads a numbered list under a bolded heading', () => {
        const ac = parseAcceptanceCriteria('**Acceptance Criteria:**\n1. First thing\n2. Second thing\n');
        expect(ac).toEqual(['First thing', 'Second thing']);
    });

    it('falls back to checkboxes anywhere in the body', () => {
        const ac = parseAcceptanceCriteria('Blah\n- [x] Handles empty input\n- [ ] Handles null input\n');
        expect(ac).toEqual(['Handles empty input', 'Handles null input']);
    });

    it('falls back to Given/When/Then', () => {
        const ac = parseAcceptanceCriteria('Given a failed call\nWhen retried\nThen it succeeds');
        expect(ac).toHaveLength(3);
        expect(ac[0]).toMatch(/^Given/);
    });

    it('returns nothing for a description with no criteria', () => {
        expect(parseAcceptanceCriteria('Just a normal description.')).toEqual([]);
        expect(parseAcceptanceCriteria('')).toEqual([]);
    });

    it('caps a runaway list', () => {
        const body = '## Acceptance Criteria\n' +
            Array.from({ length: 40 }, (_, i) => `- criterion number ${i}`).join('\n');
        expect(parseAcceptanceCriteria(body)).toHaveLength(15);
    });
});

describe('buildHostContext', () => {
    it('summarises pipeline, approvals and open threads', () => {
        const host = buildHostContext({
            platform: 'gitlab',
            pipeline: { status: 'failed', webUrl: 'http://ci' },
            failedJobs: ['unit-tests'],
            reviews: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }],
            comments: [{ resolved: false }, { resolved: true }],
            stats: { changedFiles: 3, additions: 10, deletions: 2 },
        });

        expect(host.pipelineStatus).toBe('failed');
        expect(host.failedJobs).toEqual(['unit-tests']);
        expect(host.approvals).toBe(1);
        expect(host.changesRequested).toBe(1);
        expect(host.openDiscussions).toBe(1);
    });

    it('does not throw on a minimal PR object', () => {
        expect(() => buildHostContext({})).not.toThrow();
    });
});

describe('buildIntentBlock', () => {
    it('is empty when there is genuinely nothing to say', () => {
        expect(buildIntentBlock({ description: '' })).toBe('');
    });

    it('renders acceptance criteria with an explicit instruction to check the diff against them', () => {
        const block = buildIntentBlock({ description: '' }, {
            issue: {
                key: 'PROJ-42',
                summary: 'Add retry',
                type: 'Story',
                description: '## Acceptance Criteria\n- Retries on 5xx\n- Emits a metric',
            },
        });

        expect(block).toContain('PROJ-42 — Add retry');
        expect(block).toContain('1. Retries on 5xx');
        expect(block).toContain('2. Emits a metric');
        expect(block).toContain('Check the diff against these');
        // Must warn against inventing criteria — the failure mode of this feature.
        expect(block).toContain('Do NOT invent criteria');
    });

    it('prefers explicitly supplied criteria over parsing the description', () => {
        const block = buildIntentBlock({}, {
            issue: { key: 'A-1', acceptanceCriteria: ['supplied one'], description: '- [ ] parsed one' },
        });
        expect(block).toContain('supplied one');
        expect(block).not.toContain('parsed one');
    });

    it('mentions referenced issue keys even when the issue itself is unavailable', () => {
        const block = buildIntentBlock({ branches: { source: 'feature/PROJ-9-x' }, description: 'hi' });
        expect(block).toContain('PROJ-9');
        expect(block).toContain('details unavailable');
    });

    it('surfaces failing CI with a named job and asks whether the diff explains it', () => {
        const block = buildIntentBlock({
            description: 'x',
            pipeline: { status: 'failed' },
            failedJobs: ['test_kafka_consumer'],
        });
        expect(block).toContain('**CI pipeline**: failed');
        expect(block).toContain('test_kafka_consumer');
        expect(block).toContain('whether this diff explains the failure');
    });

    it('does not add CI guidance when the pipeline is green', () => {
        const block = buildIntentBlock({ description: 'x', pipeline: { status: 'success' } });
        expect(block).toContain('**CI pipeline**: success');
        expect(block).not.toContain('explains the failure');
    });

    it('strips HTML comments and PR-template boilerplate from the description', () => {
        const block = buildIntentBlock({
            description: '<!-- hidden -->Real purpose here\n- [x] I have added tests',
        });
        expect(block).toContain('Real purpose here');
        expect(block).not.toContain('hidden');
        expect(block).not.toContain('I have added tests');
    });

    it('truncates a very long description rather than flooding the prompt', () => {
        const block = buildIntentBlock({ description: 'x'.repeat(5000) });
        expect(block).toContain('description truncated');
        expect(block.length).toBeLessThan(2000);
    });
});

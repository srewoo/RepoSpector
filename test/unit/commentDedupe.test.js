const {
    REPOSPECTOR_MARKER,
    isRepoSpectorComment,
    withMarker,
    tokenize,
    maxCosineSimilarity,
    collectPriorBotComments,
    suppressAlreadyPosted,
} = require('../../src/utils/commentDedupe.js');

describe('marker', () => {
    it('recognises its own comments', () => {
        expect(isRepoSpectorComment(`${REPOSPECTOR_MARKER}\nhello`)).toBe(true);
    });

    it('recognises legacy comments posted before the marker existed', () => {
        expect(isRepoSpectorComment('<sub>🛡️ RepoSpector · AI review</sub>')).toBe(true);
    });

    it('does not claim a human comment', () => {
        expect(isRepoSpectorComment('please rename this to tenant_id')).toBe(false);
        expect(isRepoSpectorComment('')).toBe(false);
        expect(isRepoSpectorComment(null)).toBe(false);
    });

    it('is idempotent — re-marking does not stack markers', () => {
        const once = withMarker('body');
        const twice = withMarker(once);
        expect(twice).toBe(once);
        expect(twice.match(/repospector-finding-v1/g)).toHaveLength(1);
    });
});

describe('tokenize', () => {
    it('strips markdown chrome so template boilerplate does not dominate', () => {
        const tokens = tokenize([
            '<!-- repospector-finding-v1 -->',
            '🟠 **HIGH** (`no-eval`): Avoid eval',
            '<details><summary>Evidence</summary>',
            '```',
            'eval(userInput)',
            '```',
            '</details>',
            '<sub>🛡️ RepoSpector · AI review · confidence 80%</sub>',
        ].join('\n'));

        expect(tokens).toContain('avoid');
        expect(tokens).toContain('eval');
        // Chrome that appears in every comment must not survive.
        expect(tokens).not.toContain('repospector');
        expect(tokens).not.toContain('evidence');
        expect(tokens).not.toContain('confidence');
        expect(tokens).not.toContain('userinput');
    });

    it('drops stopwords and very short tokens', () => {
        expect(tokenize('the a of is in on')).toEqual([]);
    });
});

describe('maxCosineSimilarity', () => {
    it('is 0 against an empty corpus', () => {
        expect(maxCosineSimilarity('anything', [])).toBe(0);
    });

    it('scores identical text near 1 and unrelated text low', () => {
        const target = 'empty catch block swallows the error silently';
        const same = maxCosineSimilarity(target, ['empty catch block swallows the error silently']);
        const different = maxCosineSimilarity(target, ['rename this variable to tenant_id for consistency']);

        expect(same).toBeGreaterThan(0.9);
        expect(different).toBeLessThan(0.2);
        expect(same).toBeGreaterThan(different);
    });
});

describe('collectPriorBotComments', () => {
    const prData = {
        comments: [
            { path: 'a.js', line: 5, body: `${REPOSPECTOR_MARKER}\nours`, author: 'me' },
            { path: 'a.js', line: 6, body: 'a human said this', author: 'alice' },
            { path: 'a.js', line: 7, body: 'another bot said this', author: 'coderabbit' },
        ],
    };

    it('collects only our own comments by default', () => {
        const prior = collectPriorBotComments(prData);
        expect(prior).toHaveLength(1);
        expect(prior[0].mine).toBe(true);
    });

    it('can opt into treating other review bots as prior art', () => {
        const prior = collectPriorBotComments(prData, { includeOtherBots: true });
        expect(prior).toHaveLength(2);
    });

    it('survives PR data with no comments', () => {
        expect(collectPriorBotComments({})).toEqual([]);
        expect(collectPriorBotComments(null)).toEqual([]);
    });
});

describe('suppressAlreadyPosted', () => {
    const prior = [{
        path: 'src/hooks/useSplitFraction.js',
        line: 38,
        body: 'Empty catch block swallows the error silently, so JSON parse failures are invisible',
        author: 'me',
        mine: true,
    }];

    it('suppresses a finding we already commented on', () => {
        const { kept, suppressed } = suppressAlreadyPosted([{
            file: 'src/hooks/useSplitFraction.js',
            line: 38,
            title: 'Empty catch block swallows the error silently',
        }], prior);

        expect(kept).toHaveLength(0);
        expect(suppressed).toHaveLength(1);
        expect(suppressed[0].suppressedBy.reason).toBe('similarity');
    });

    it('tolerates small line drift from an unrelated edit above the finding', () => {
        const { kept } = suppressAlreadyPosted([{
            file: 'src/hooks/useSplitFraction.js',
            line: 40,
            title: 'Empty catch block swallows the error silently',
        }], prior);
        expect(kept).toHaveLength(0);
    });

    it('keeps the same defect found at a genuinely different location', () => {
        const { kept } = suppressAlreadyPosted([{
            file: 'src/hooks/useSplitFraction.js',
            line: 47,
            title: 'Empty catch block swallows the error silently',
        }], prior);
        expect(kept).toHaveLength(1);
    });

    it('keeps a different defect at the same location', () => {
        const { kept } = suppressAlreadyPosted([{
            file: 'src/hooks/useSplitFraction.js',
            line: 38,
            title: 'localStorage quota may be exceeded on write',
        }], prior);
        expect(kept).toHaveLength(1);
    });

    it('matches on rule id exactly, without needing prose agreement', () => {
        const { kept, suppressed } = suppressAlreadyPosted([{
            file: 'a.js', line: 3, rule: 'no-eval', title: 'totally different words here',
        }], [{ path: 'a.js', line: 3, body: 'previously flagged (`no-eval`)', mine: true }]);

        expect(kept).toHaveLength(0);
        expect(suppressed[0].suppressedBy.reason).toBe('rule-id');
    });

    it('matches paths by suffix, since hosts disagree about path prefixes', () => {
        const { kept } = suppressAlreadyPosted([{
            file: 'applications/app/src/hooks/useSplitFraction.js',
            line: 38,
            title: 'Empty catch block swallows the error silently',
        }], prior);
        expect(kept).toHaveLength(0);
    });

    it('is a no-op when there are no prior comments', () => {
        const findings = [{ file: 'a.js', line: 1, title: 'x' }];
        const { kept, stats } = suppressAlreadyPosted(findings, []);
        expect(kept).toEqual(findings);
        expect(stats.suppressed).toBe(0);
    });
});

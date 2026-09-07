/**
 * `src/popup/utils/findingsParser.js` maps raw findings into the shape the
 * popup renders. It must preserve deterministic `source` values — static,
 * external, graph (see `findingSources.js`) — rather than collapsing anything
 * that is not `'static'` into `'ai'`. A `source: 'graph'` finding relabelled
 * `'ai'` here would render as AI output in the panel while the PR comment for
 * the same finding says "code graph" — the exact split the taxonomy exists to
 * prevent.
 */
const { convertVerifiedFindings } = require('../../src/popup/utils/findingsParser.js');

describe('convertVerifiedFindings source taxonomy', () => {
    it('preserves a graph source rather than relabelling it ai', () => {
        const [parsed] = convertVerifiedFindings([
            { file: 'a.js', line: 1, source: 'graph', tool: 'code-graph', title: 't' },
        ]);
        expect(parsed.source).toBe('graph');
        expect(parsed.tool).toBe('code-graph');
    });

    it('preserves a static source', () => {
        const [parsed] = convertVerifiedFindings([
            { file: 'a.js', line: 1, source: 'static', title: 't' },
        ]);
        expect(parsed.source).toBe('static');
    });

    it('preserves an external source', () => {
        const [parsed] = convertVerifiedFindings([
            { file: 'a.js', line: 1, source: 'external', tool: 'codeql', title: 't' },
        ]);
        expect(parsed.source).toBe('external');
        expect(parsed.tool).toBe('codeql');
    });

    it('still collapses genuine model output to ai', () => {
        const [parsed] = convertVerifiedFindings([
            { file: 'a.js', line: 1, source: 'llm', title: 't' },
        ]);
        expect(parsed.source).toBe('ai');
    });

    it('defaults to ai when no source is present', () => {
        const [parsed] = convertVerifiedFindings([{ file: 'a.js', line: 1, title: 't' }]);
        expect(parsed.source).toBe('ai');
    });
});

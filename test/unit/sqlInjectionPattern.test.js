/**
 * `no-sql-injection`, the next `no-dupe-keys`.
 *
 * On a real review it produced ELEVEN critical findings in a repository with no
 * SQL at all. The cause is its last alternative — `['"`]\s*\+\s*\w+` — which
 * matches ANY string concatenation: `'Bearer ' + token`, `'run-' + issueKey`,
 * a message built from a variable. Reported as `critical`, `CWE-89`.
 *
 * A critical severity that fires on string concatenation is worse than no rule:
 * it is the loudest thing in the section and it is almost always wrong.
 */

const { ESLintAnalyzer } = require('../../src/services/ESLintAnalyzer.js');

const analyzer = () => new ESLintAnalyzer({ useRealEngine: false });
const sqlHits = (code) => analyzer()
    .analyze(code, { filePath: 'x.ts' })
    .findings.filter((f) => f.ruleId === 'no-sql-injection');

describe('does not fire on ordinary string concatenation', () => {
    it('a header built from a token', () => {
        expect(sqlHits("const auth = 'Bearer ' + token;")).toEqual([]);
    });

    it('a label built from an id', () => {
        expect(sqlHits("const label = 'run-' + issueKey;")).toEqual([]);
    });

    it('a log message built from a variable', () => {
        expect(sqlHits("logger.warn('failed for ' + storyKey);")).toEqual([]);
    });

    it('a URL path built from a variable', () => {
        expect(sqlHits("const url = base + '/api/v1/' + id;")).toEqual([]);
    });

    it('a tool description assembled from strings', () => {
        expect(sqlHits("description: 'mode=search → search by ref. ' + 'mode=coverage → gaps.',")).toEqual([]);
    });
});

describe('still fires on real query building', () => {
    it('a template-interpolated SELECT passed to query()', () => {
        const hits = sqlHits('db.query(`SELECT * FROM users WHERE id = ${userId}`);');
        expect(hits).toHaveLength(1);
        expect(hits[0].severity).toBe('critical');
    });

    it('a concatenated SELECT passed to query()', () => {
        expect(sqlHits("db.query('SELECT * FROM users WHERE id = ' + userId);")).toHaveLength(1);
    });

    it('a concatenated DELETE passed to execute()', () => {
        expect(sqlHits("conn.execute('DELETE FROM runs WHERE id = ' + runId);")).toHaveLength(1);
    });

    it('an UPDATE built with template interpolation', () => {
        expect(sqlHits('exec(`UPDATE cases SET title = ${title}`);')).toHaveLength(1);
    });
});

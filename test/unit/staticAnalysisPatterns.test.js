/**
 * The regex rule patterns behind the ESLint-style analyzer.
 *
 * These fixtures are not invented. They are the object literals a real
 * `review_pr` bundle reported `no-dupe-keys` on, from
 * `apps/api-gateway/src/api/api.controller.ts` of a reviewed merge request —
 * three findings, every one wrong, on schemas whose keys are all distinct.
 *
 * The mechanism: the rule's backreference was not anchored to a key position,
 * so `\w+` matched a SUFFIX of a key. From `testCases:` it captured the single
 * character `s`, then matched the `s:` ending `existingCaseIds:` — a
 * "duplicate" that shares one letter. `id:` / `projectId:` fails the same way.
 *
 * A rule that fires on distinct keys is worse than a missing rule: the review
 * bundle labels this output "facts about the code", so a reader quotes it.
 */

const { ESLintAnalyzer } = require('../../src/services/ESLintAnalyzer.js');

/** The regex path only — that is what runs for `.ts`, where the real hit landed. */
const analyzer = () => new ESLintAnalyzer({ useRealEngine: false });

const findings = (code, filePath = 'schema.ts') =>
    analyzer().analyze(code, { filePath }).findings;

const dupeKeys = (code, filePath) =>
    findings(code, filePath).filter((f) => f.ruleId === 'no-dupe-keys');

// Verbatim from the merge request that exposed this.
const REVIEW_REQUEST_SCHEMA = `const ReviewRequestSchema = z.object({
  issueKey: z.string().min(1),
  issueTitle: z.string().min(1),
  testCases: z.array(z.unknown()),
  existingCaseIds: z.array(z.string()).optional(),
});`;

const VECTOR_UPLOAD_SCHEMA = `const VectorUploadSchema = z.object({
  cases: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      projectId: z.string().min(1),
      projectName: z.string().default(''),
      typeName: z.string().default('functional'),
      priorityName: z.string().default('Medium'),
    }),
  ).min(1).max(5000),
});`;

describe('no-dupe-keys does not fire on distinct keys', () => {
    it('a key ending in the same letter as an earlier key is not a duplicate', () => {
        // `testCases` / `existingCaseIds` — the exact reported false positive.
        expect(dupeKeys(REVIEW_REQUEST_SCHEMA)).toEqual([]);
    });

    it('a nested object whose keys share suffixes is not a duplicate', () => {
        // `id` / `projectId`, `title` / `typeName` — the second reported hit.
        expect(dupeKeys(VECTOR_UPLOAD_SCHEMA)).toEqual([]);
    });

    it('two distinct keys on one line are not a duplicate', () => {
        // The third reported hit: `{ type: 'error', message: ... }`.
        expect(dupeKeys("sendSSEMessage(res, { type: 'error', message: err.message });")).toEqual([]);
    });

    it('the same key name in two SEPARATE object literals is not a duplicate', () => {
        const code = `const a = { issueKey: 1, issueTitle: 2 };
const b = { issueKey: 3, issueTitle: 4 };`;
        expect(dupeKeys(code)).toEqual([]);
    });
});

describe('no-dupe-keys still fires on a real duplicate', () => {
    it('the same key twice in one literal', () => {
        const hits = dupeKeys('const o = { retries: 1, timeout: 30, retries: 2 };');
        expect(hits).toHaveLength(1);
        expect(hits[0].message).toMatch(/[Dd]uplicate keys/);
    });

    it('a duplicate spanning several lines', () => {
        const code = `const config = {
  host: 'localhost',
  port: 8080,
  host: 'other',
};`;
        expect(dupeKeys(code)).toHaveLength(1);
    });

    it('a duplicate quoted key', () => {
        expect(dupeKeys(`const o = { 'a-b': 1, c: 2, 'a-b': 3 };`)).toHaveLength(1);
    });
});

describe('regex findings say they came from a regex', () => {
    /**
     * The review bundle's rubric tells its reader the static section is "real
     * linter ... output. No model produced these; they are facts about the
     * code." Labelling a pattern match `tool: 'eslint'` with nothing to
     * distinguish it from the AST engine is how a regex artifact gets quoted as
     * a fact. The AST path already reports `engine: 'acorn-ast'`; the regex path
     * must be equally explicit about what it is.
     */
    it('names the engine on the result', () => {
        const result = analyzer().analyze('const o = { a: 1, a: 2 };', { filePath: 'x.ts' });
        expect(result.engine).toBe('regex');
    });

    it('names the engine on every finding', () => {
        const hits = dupeKeys('const o = { a: 1, a: 2 };');
        expect(hits).toHaveLength(1);
        expect(hits[0].engine).toBe('regex');
    });
});

describe('no-dupe-keys does not read key-like text inside strings', () => {
    /**
     * The second false-positive mechanism in this rule, found by re-reviewing
     * the same merge request after the anchoring fix: a *string value* that
     * contains `word:` looks like a key. In
     * `apps/mcp-server/src/tools/tool-handlers.ts` the JSON-schema property
     *
     *     type: { type: 'string', description: 'Filter by case type: functional | ...' }
     *
     * matched because `type:` occurs inside the description text. The rule is
     * about object keys; text inside a literal is not one.
     */
    it('a description string containing "type:" is not a duplicate key', () => {
        const code = `const schema = {
  type: {
    type: 'string',
    description: 'Filter by case type: functional | security | ui',
  },
};`;
        expect(dupeKeys(code)).toEqual([]);
    });

    it('a template literal containing a key-like span is not a duplicate key', () => {
        const code = 'const o = { name: `pick a name: any name` , other: 1 };';
        expect(dupeKeys(code)).toEqual([]);
    });

    it('a real duplicate is still found when strings are present', () => {
        const code = `const o = {
  host: 'example.com: not a key',
  port: 1,
  host: 'other',
};`;
        expect(dupeKeys(code)).toHaveLength(1);
    });

    it('reports the line of the real code, not of a blanked string', () => {
        const code = `const a = 1;\nconst o = { k: 'x: y', k: 2 };`;
        const hits = dupeKeys(code);
        expect(hits).toHaveLength(1);
        expect(hits[0].line).toBe(2);
    });
});

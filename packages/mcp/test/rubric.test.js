import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRubric } from '../src/tools/rubric.js';

test('states the review criteria', () => {
    const r = buildRubric();
    assert.ok(r.length > 200, 'a rubric this short cannot carry the criteria');
    assert.match(r, /correctness|bug/i);
    assert.match(r, /security/i);
});

test('does NOT claim the reader is a Chrome extension', () => {
    // PR_ANALYSIS_SYSTEM_PROMPT says "You are RepoSpector, an AI-powered code
    // analysis Chrome extension … with direct access to data from the user's
    // browser". Through MCP that is false: the reader is Claude and the code
    // arrives in the bundle. Passing it through verbatim would assert something
    // untrue in the reader's own context.
    const r = buildRubric();
    assert.doesNotMatch(r, /Chrome extension/i);
    assert.doesNotMatch(r, /from the user's browser/i);
    assert.doesNotMatch(r, /NEVER claim you cannot see/i);
});

test('tells the reader where the evidence in the bundle comes from', () => {
    const r = buildRubric();
    assert.match(r, /static analysis|static_analysis/i);
});

/**
 * The rubric is the one part of the bundle `review_pr` AUTHORS, so a claim it
 * makes about the evidence is a claim the reader will act on. Two sentences in
 * it were false, and both were quoted back as fact in a real review:
 *
 *   - "graph_context: callers and callees of the touched symbols" — it returned
 *     repo-wide node and edge counts.
 *   - "static_analysis: real linter ... No model produced these; they are facts
 *     about the code" — a regex pattern matcher had produced them, and four of
 *     four were mis-mapped.
 */

test('does not call the static section a real linter without qualification', () => {
    const r = buildRubric();
    assert.doesNotMatch(
        r, /real linter/i,
        'the regex fallback is not a linter; the bundle reports which engine ran',
    );
    assert.doesNotMatch(
        r, /they are facts about the code/i,
        'this sentence is why a regex artifact was quoted as a defect',
    );
});

test('tells the reader the static section names its own engine and refusals', () => {
    const r = buildRubric();
    assert.match(r, /engine/i);
    assert.match(r, /premise|refuted|withheld/i);
});

test('describes provenance, so the reader can check what each section describes', () => {
    const r = buildRubric();
    assert.match(r, /provenance/i);
    assert.match(r, /revision|stale/i);
});

test('promises of graph_context and covering_tests match what they now carry', () => {
    const r = buildRubric();
    // Both sections are scoped to the change; the rubric must say so rather
    // than promising something a repo-wide aggregate cannot deliver.
    assert.match(r, /removed|deleted/i);
});

test('does not ask the reader to use a section that cannot be populated', () => {
    // `prior_findings` is fed by `PriorFindingService`, which reads a
    // `feedbackCollector.getLedger()`. This server has no collector and, by
    // design, authors no findings to record — so the section is structurally
    // empty, not merely empty today. The rubric said "issues raised before on
    // this repository. Say so when a finding repeats one", which asks for a
    // comparison the bundle can never supply.
    const r = buildRubric();
    assert.doesNotMatch(r.replace(/\s+/g, ' '), /Say so when a finding repeats one/);
    assert.match(r, /prior_findings/);
    assert.match(r, /no ledger|not recorded|cannot|no history/i);
});

test('describes the section that looks outside the diff', () => {
    const r = buildRubric().replace(/\s+/g, ' ');
    assert.match(r, /surviving_references/);
    assert.match(r, /outside the diff/i);
    assert.match(r, /evidence, not a verdict/i);
});

test('warns that unanswered OSV packages are not clean', () => {
    const r = buildRubric().replace(/\s+/g, ' ');
    assert.match(r, /packagesUnchecked/);
    assert.match(r, /never read those as clean/i);
});

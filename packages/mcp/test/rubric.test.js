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

/**
 * Review instructions for the `review_pr` bundle.
 *
 * Deliberately NOT `PR_ANALYSIS_SYSTEM_PROMPT` verbatim. That prompt opens by
 * telling the model it is "an AI-powered code analysis Chrome extension with
 * direct access to Pull Request data from the user's browser" and instructs it
 * never to claim it cannot see the code. Through MCP every clause of that is
 * false: the reader is Claude, and the code arrives inside the bundle rather
 * than from a browser. Asserting it anyway would put an untrue premise in the
 * reader's own context.
 *
 * The criteria below are the transport-independent half of the same rubric, so
 * a review produced here and one produced in the extension judge the same
 * things.
 */
export function buildRubric() {
    return [
        'Review the changes in this bundle. Report only defects you can point at.',
        '',
        'Judge, in this order:',
        '1. Correctness — wrong behaviour, unhandled cases, broken invariants. Name the',
        '   input or state that triggers the failure and what goes wrong.',
        '2. Security — untrusted input reaching a sink, missing authorisation, leaked',
        '   credentials, injection. The bundle\'s static_analysis section already',
        '   contains deterministic secret-scan and linter results; treat those as',
        '   evidence rather than re-deriving them.',
        '3. Tests — behaviour the change introduces that nothing covers. The',
        '   covering_tests section lists what already exercises the touched code.',
        '4. Maintainability — duplication of a logic block, swallowed errors, a',
        '   contract that now disagrees with its callers.',
        '',
        'Use the evidence supplied:',
        '- hunks: the changed lines, windowed so large files stay legible.',
        '- graph_context: callers and callees of the touched symbols, so you can see',
        '  what a change reaches beyond the diff.',
        '- similar_code: comparable code retrieved from the repository, so you can',
        '  judge whether the change follows the conventions already in use.',
        '- prior_findings: issues raised before on this repository. Say so when a',
        '  finding repeats one.',
        '- static_analysis: real linter, tree-sitter and secret-scan output. No model',
        '  produced these; they are facts about the code.',
        '',
        'Do not report style preferences, and do not restate what the diff does.',
    ].join('\n');
}

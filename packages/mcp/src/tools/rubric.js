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
        '   credentials, injection. The bundle\'s static_analysis section carries',
        '   deterministic secret-scan and rule output; treat it as evidence to check,',
        '   not as a conclusion — it names the engine that produced each finding, and',
        '   a `regex` finding is a pattern match that may not hold. Verify a static',
        '   finding against the hunk before repeating it.',
        '3. Tests — behaviour the change introduces that nothing covers, and coverage',
        '   the change removes. covering_tests names the tests over the touched',
        '   symbols and the test files this change deletes.',
        '4. Maintainability — duplication of a logic block, swallowed errors, a',
        '   contract that now disagrees with its callers.',
        '',
        'Use the evidence supplied:',
        '- hunks: the changed lines, windowed so large files stay legible. Source is',
        '  ordered ahead of docs and lockfiles, and a window trimmed to fit says so.',
        '- graph_context: callers and callees of the symbols this change touches, plus',
        '  `removed` — symbols the change deletes, with the callers they still have.',
        '  `graph` holds repo-wide totals as provenance only, never as an answer.',
        '- covering_tests: coverage of THIS change — tests covering the touched',
        '  symbols, and the test files it deletes or modifies. `repoWide` is',
        '  background. An "untested" symbol may only be one the graph could not link.',
        '- similar_code: comparable code retrieved for the touched symbols and paths,',
        '  so you can judge whether the change follows conventions already in use.',
        '- prior_findings: normally the issues raised before on this repository. This',
        '  server has no feedback ledger wired and authors no findings of its own, so',
        '  the section cannot be populated here — treat it as absent, not as proof that',
        '  nothing repeats.',
        '- static_analysis: pattern, tree-sitter and secret-scan output, plus the',
        '  `engines` that produced it — `regex` is a pattern matcher, not a parser, so',
        '  weigh it accordingly. `premiseRefuted` lists findings withheld because the',
        '  rule\'s own construct was absent where it fired. `source` says whether whole',
        '  files at the reviewed revision or only the patch\'s added lines were read.',
        '- surviving_references: for each symbol this change REMOVES, where its name',
        '  still appears elsewhere in the repository at the reviewed revision — the one',
        '  section that looks outside the diff. A hit is evidence, not a verdict: a name',
        '  may legitimately remain in an ADR recording its removal. Code references',
        '  outrank documentation ones, and skipped names were searched for nothing.',
        '- dependencies: OSV advisories for packages in the manifests this change',
        '  touches. `packagesUnchecked` are packages OSV did not answer for — never',
        '  read those as clean.',
        '- provenance: which revision every section above describes — the reviewed',
        '  base and head, the worktree, and how far the index is from that base.',
        '  Treat graph and retrieval sections as suspect when `index.stale` is true,',
        '  and say so rather than reporting a finding you cannot ground.',
        '',
        'Do not report style preferences, and do not restate what the diff does.',
    ].join('\n');
}

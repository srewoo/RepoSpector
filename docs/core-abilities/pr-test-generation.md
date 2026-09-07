# PR-scoped test generation

**Module:** `src/services/PRTestGenerationService.js` · entry points: the PR-level
**Generate Tests** quick action and the per-finding **Write Test** action,
which appears only on `static/missing-test` findings
(`src/popup/components/PRReviewInterface.jsx`, `QuickActions.jsx`) ·
handler: `GENERATE_PR_TESTS` (`src/background/handlers/generatorHandlers.js`)

## The problem

Test generation ran on whatever single file the user had open. The review
already reports, deterministically, that a PR adds an exported symbol no test
covers (`static/missing-test`) — but that finding and test generation were two
disconnected features. Nothing carried the review's own coverage gap into the
thing that could fill it.

The per-finding **Write Test** action is offered only on `static/missing-test`
findings — see "What it does not do" below for why `graph/untested-blast-radius`
findings, despite also being tagged `coverage`, do not get it.

## What it does

The PR-level action runs `findMissingTests` over the whole PR and groups the
result into `{ file, symbols[] }` targets, most-symbols-first, capped at
`maxFiles` (default `3`). The per-finding **Write Test** action calls the same
generator scoped to one file and one symbol (`onlyFiles`/`onlySymbols`,
`maxFiles: 1`), so clicking it on a single finding does not also regenerate
tests for everything else the PR is missing.

For each target, `_generateOne` builds a prompt (`src/utils/prTestPrompts.js`)
that includes the source, the symbols to cover, and — when a code graph is
available — up to 3 real call sites per symbol via `listCallers`, so the model
writes arguments production actually passes rather than invented ones. If the
repository already has a test file for the target (found the same way the
review finds it, through `ReviewFileContextService`), the prompt asks for
append-only blocks in that file's style and the result is marked `mode:
'append'`; otherwise it asks for a new file and the result is `mode: 'create'`.

The framework is chosen by file extension (`EXT_FRAMEWORK` in
`prTestPrompts.js`): `.py` → pytest, `.go` → go test, `.java` → junit, and so
on. `detectFramework` (which inspects an existing test file's own imports) is
consulted only for the JS-family extensions (`js/jsx/ts/tsx/mjs/cjs`) —
because it defaults to `jest` with no "I don't know" signal, and trusting it
on a `.py` file would label a pytest suite `jest`.

Output is gated before it is ever shown: syntax check, then quality check
(`validateTestQuality`), and one retry that feeds the validator's own error
message back to the model as a follow-up user turn ("Your previous output
failed validation: … Fix it and output ONLY the corrected code."). A file that
still fails after the retry is not returned as a file — it is returned as a
skip, with the validator's reason attached.

The result of `generate()` is `{ files, skipped, usage }`:
- `files[]` — `{ path, targetFile, mode, symbols, framework, content, quality: { syntaxOk, score, attempts } }`.
- `skipped[]` — `{ file, reason }`, for every target that produced no file at all.
- `usage` — accumulated `{ input, output }` token counts across every LLM call the generation made.

## Every skip reports a reason

There is no silent skip. `skipped` always carries a `reason` string — "source
content unavailable", "syntax: …", "quality score N below 40: …", or (when
the PR has no untested exported symbols at all) "no untested exported symbols
in this PR". This matters because a silent skip reads as "nothing to test",
which is the opposite of what actually happened — the file had something to
test and the generator gave up on it. The results panel
(`GeneratedTestsPanel.jsx`) renders every skip with its reason next to it.

## The code graph is optional enrichment

`handleGeneratePRTests` tries to load the repo's code graph and passes it to
`PRTestGenerationService` when available; on any failure it logs a warning and
passes `graph: null` instead of failing the request. Without a graph,
`listCallers` is simply never called and the prompt has no call-site section —
tests still generate, just with less-informed arguments.

## What it does not do

- **The per-finding action does not offer itself on `graph/untested-blast-radius`
  findings**, even though that finding is also tagged `category: 'coverage'`.
  That finding's title names the symbol that CHANGED, not the untested
  dependents it is actually about, and those dependents live in files outside
  the PR's diff — `ReviewFileContextService` builds its candidates from
  `prData.files`, so it structurally cannot fetch their source. Offering
  **Write Test** there would always silently skip, so `QuickActions.jsx`
  gates the action on `offersTestGeneration` (`src/utils/prTestPrompts.js`),
  which matches only `static/missing-test`.
- **Nothing is committed.** Generated tests are shown in the panel for the
  user to copy (`GeneratedFile`'s Copy button); RepoSpector does not write
  them to the PR branch. A follow-up could push them via the GitHub/GitLab
  contents API — that is out of scope here.
- **TypeScript gets a shallower syntax check than JavaScript.**
  `SYNTAX_CHECKED_LANGUAGES` in `PRTestGenerationService.js` contains only
  `'javascript'`. `validateSyntax` misreads TypeScript generics (e.g.
  `Map<string, number>`) as JSX, and its regex-based TypeScript stripper
  corrupts annotated declarations before handing them to the function-based
  syntax check — both pre-existing bugs in that shared validator. So
  TypeScript (and every other non-JS language) skips `validateSyntax`
  entirely and relies on `validateTestQuality`'s own parse-failure path,
  which uses `quickValidate` — brace/paren/bracket counting only. Weaker, but
  sound: no false positives, just a coarser net.
- **There is no automated render test for the results panel.** This repo has
  no `@testing-library/react` installed and jest cannot transform `.jsx`
  files (see the `transformIgnorePatterns`/jest config in `package.json`), so
  `GeneratedTestsPanel.jsx` itself has no test. Its actual decision logic —
  what headline to show, how to label a skip, whether to render at all —
  lives in the plain `.js` helper `generatedTestsPanelLogic.js`
  (`summarizeGeneratedTests`), which IS unit-tested
  (`test/unit/generatedTestsPanelLogic.test.js`). The component is left as
  markup only, covered by `npm run build`.

## How to measure

In the handler's response (`{ success, data: { files, skipped, usage } }`):
count `files.length` against `skipped.length` to see how much of a PR's
missing coverage actually produced usable output, and read each generated
file's `quality.attempts` — `1` means it passed on the first try, `2` means
the retry-with-validator-feedback loop was needed to get there.

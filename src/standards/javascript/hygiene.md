# JavaScript / TypeScript Hygiene Standards

## JS-CODING-030: Suppression comments require a stated reason
An `eslint-disable` or `eslint-disable-next-line` with no explanation is unreviewable — the next reader cannot tell a considered exception from a silenced warning. State why the rule does not apply on the line above.

## JS-CODING-031: Every promise must be awaited, returned, or caught
A floating promise runs detached: its rejection surfaces as an unhandled rejection far from the cause, and its completion is not ordered against anything. Await it, return it, or attach a `.catch`.

## JS-CODING-032: No `console.*` in production code
Console output is unstructured, unfiltered, and ships to users. Use the project's logger. Test files are exempt — see JS-TEST-002 for the rule that applies there.

## JS-CODING-033: No commented-out code
Commented-out blocks rot: they are not compiled, not tested, and not updated with the code around them. Delete them — version control is the archive.

## JS-CODING-034: No unused variables, imports, or parameters
An unused import or binding is either dead weight or a symptom of an incomplete edit — most often a refactor that removed the use and left the declaration.

## TS-CODING-010: `@ts-ignore` and `@ts-expect-error` require a stated reason
Both switch off the type checker for a line. Without a comment saying which error is being suppressed and why it is safe, the suppression outlives the reason for it. Prefer `@ts-expect-error`, which fails once the underlying error is fixed.

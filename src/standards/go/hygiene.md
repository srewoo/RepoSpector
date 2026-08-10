# Go Hygiene Standards

## GO-CODING-030: `//nolint` requires a stated reason
A bare `//nolint` suppresses a real finding with no record of why. Name the linter and give the reason: `//nolint:gosec // path is validated above`.

## GO-CODING-031: No commented-out code
Commented-out blocks are not compiled, so they are not kept correct. Delete them.

## GO-CODING-032: No unused variables, imports, or parameters
Go's compiler rejects unused locals and imports, so an unused one reaching review usually means a build-tagged or generated file — worth checking it is intentional.

## GO-CODING-033: Exported identifiers need doc comments
An exported symbol with no comment starting with its own name is undocumented in `go doc` and at every call site.

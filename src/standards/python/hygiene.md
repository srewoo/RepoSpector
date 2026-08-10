# Python Hygiene Standards

## PY-CODING-030: Suppression comments require a stated reason
`# noqa` and `# type: ignore` without an explanation hide a finding rather than resolving it. Name the specific code being suppressed (`# noqa: E501`, not bare `# noqa`) and say why.

## PY-CODING-031: No commented-out code
Commented-out blocks are not executed, not tested, and drift from the code around them. Delete them.

## PY-CODING-032: No unused imports or names
An unused import is dead weight, and after a refactor it is usually the residue of a removed call — worth checking that the removal was complete.

## PY-CODING-033: No wildcard imports
`from module import *` makes the origin of every name unresolvable by reading, and silently shadows locals when the module changes.

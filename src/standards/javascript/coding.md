# JavaScript / TypeScript Coding Standards

## JS-CODING-001: No deprecated string APIs
Use `substring()` instead of `substr()`. The `substr()` method is deprecated and may be removed in future environments.

## JS-CODING-002: No `__proto__` mutation
Do not assign to `__proto__`. Use `Object.create()`, `Object.setPrototypeOf()`, or class `extends`.

## JS-CODING-003: Prefer `const` and `let` over `var`
`var` has function scope and hoisting behaviour that leads to bugs. Use `const` for values that never reassign, `let` otherwise. Never use `var`.

## JS-CODING-004: Async/await over Promise chains
Prefer `async`/`await` over `.then()`/`.catch()` chains. Unhandled rejections must be caught; every `await` expression inside an `async` function must be inside a `try/catch` or have a caller that handles the rejection.

## JS-CODING-005: No `eval()` or `new Function(string)`
These constructs execute arbitrary code strings and are a direct XSS/code-injection vector. Use JSON.parse for data deserialization. If dynamic dispatch is needed, use a lookup table.

## JS-CODING-006: Explicit error handling in async code
Do not swallow errors with empty `catch` blocks. Log the error or rethrow. A catch block that does nothing hides bugs permanently.

## JS-CODING-007: No implicit globals
Every variable must be declared. Accidental globals corrupt shared state across modules and tabs.

## JS-CODING-008: Parameterised queries for all DB access
Never concatenate user input into a SQL/NoSQL query string. Use parameterised queries or an ORM that prevents injection by construction.

## JS-CODING-009: No hardcoded secrets
API keys, tokens, passwords, and connection strings must never appear in source code. Use environment variables or a secrets manager.

## JS-CODING-010: Array/object spread instead of `Object.assign` mutation
Prefer `{ ...obj, key: val }` and `[...arr, item]` over mutating originals. Mutation of shared objects is a hidden coupling.

## TS-CODING-001: `strict: true` enforced
TypeScript projects must have `"strict": true` in tsconfig. Never use `any` — use `unknown` plus narrowing guards. Use `readonly` on properties that should not be mutated after construction.

## TS-CODING-002: `zod` validation at every external boundary
All inputs crossing a trust boundary (API request body, message payload, localStorage) must be validated with a Zod schema before use. Do not rely on TypeScript types alone for runtime safety.

## TS-CODING-003: No non-null assertion without guard
The `!` postfix operator (`value!`) silently removes `null`/`undefined` from the type. It is only acceptable when a non-null invariant is proven by a preceding runtime check that TypeScript cannot track.

## TS-CODING-004: `interface` for object shapes, `type` for unions/intersections
Use `interface` when describing the shape of an object. Use `type` for union types, intersection types, and aliases of primitives.

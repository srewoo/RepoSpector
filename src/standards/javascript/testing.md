# JavaScript / TypeScript Testing Standards

## JS-TEST-001: Every exported function must have at least one unit test
Any function exported from a module that is new or modified in this PR must have a corresponding test in a `*.test.ts`, `*.test.js`, `*.spec.ts`, or `*.spec.js` file. Tests do not count if they only test implementation details — they must assert observable behaviour.

## JS-TEST-002: No `console.log` in test files
Test files must not contain `console.log`. Use test framework assertions. Log noise in CI hides real failures.

## JS-TEST-003: Test names describe behaviour, not implementation
Test names must follow the form `it('should <behaviour> when <condition>')`. Avoid names like `it('works')` or `it('test1')`.

## JS-TEST-004: No hardcoded real credentials in test fixtures
Test fixtures must use obviously fake values (e.g., `"test-api-key-12345"`), never real API keys, tokens, or passwords.

## JS-TEST-005: Async tests must await all assertions
Every `async` test that uses `await` must assert the result of the awaited expression. A test that awaits a call but never asserts its result provides false confidence.

## JS-TEST-006: Integration tests must clean up resources
Tests that create database rows, files, network connections, or mock servers must clean them up in `afterEach`/`afterAll`. Leaked resources cause non-deterministic failures in CI.

## JS-TEST-007: No skipped tests without a tracking comment
A `test.skip` or `xit` without an associated ticket reference (`// TODO: fix in #123`) hides forgotten regressions. Every skip must include a reason and a linked issue.

## JS-TEST-008: Coverage targets
- Utility functions: ≥ 95 %
- Service layer: ≥ 90 %
- Controller layer: ≥ 85 %
- Repository layer: ≥ 80 %

CI must fail if coverage drops below these targets for changed files.

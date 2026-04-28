# Python Testing Standards

## PY-TEST-001: Every exported/public function must have at least one test
Any public function (not prefixed `_`) that is new or modified in this PR must have a corresponding `test_*.py` or `*_test.py` test. Tests must assert observable return values or side effects, not just that the function runs without error.

## PY-TEST-002: Use `pytest` fixtures, not module-level globals
Test state must be isolated in `pytest` fixtures with appropriate scope (`function` by default, `session` only for read-only shared resources). Module-level mutable state causes non-deterministic test ordering bugs.

## PY-TEST-003: No `unittest.mock.patch` on implementation details
Mock at the boundary (network call, DB query), not at internal function calls. Mocking internals couples the test to the implementation and breaks on refactors.

## PY-TEST-004: Async tests must use `pytest-asyncio`
All `async def test_*` functions must be decorated `@pytest.mark.asyncio`. Do not create a new event loop manually inside a test — it conflicts with the pytest-asyncio event loop.

## PY-TEST-005: No `time.sleep()` in tests
Tests must not use `time.sleep()` to wait for async results. Use `asyncio.wait_for()`, polling with exponential backoff, or test fixtures that produce deterministic state.

## PY-TEST-006: Coverage targets
- Core business logic: ≥ 90 %
- Utilities: ≥ 95 %
- CLI entrypoints: ≥ 80 %

Run `pytest --cov` in CI and fail if coverage drops below thresholds for changed files.

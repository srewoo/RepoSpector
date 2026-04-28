# Go Testing Standards

## GO-TEST-001: Every exported function must have at least one test
Any exported function (starts with uppercase) that is new or modified in this PR must have a corresponding `_test.go` file with at least one `Test*` function exercising it. Tests must assert both success and error paths.

## GO-TEST-002: Table-driven tests for all non-trivial logic
Functions with branching logic (if/switch) must use table-driven test structure. Each branch must be exercised by at least one test case.

## GO-TEST-003: Use `testify/assert` or stdlib `testing` — not both
Choose one assertion library per package. Mixing `t.Errorf` with `assert.Equal` creates inconsistent test output. Prefer `testify/assert` for readability.

## GO-TEST-004: Use `testcontainers-go` for external dependencies
Tests that require a real database, Redis, Kafka, or HTTP server must use `testcontainers-go` to spin up a real instance. Do not mock at the driver level; test the real integration.

## GO-TEST-005: No `time.Sleep` in tests
Use `testify/mock`, channels, or `sync.WaitGroup` to synchronise test goroutines. `time.Sleep` produces flaky tests that pass locally and fail under load in CI.

## GO-TEST-006: Coverage targets
- Business logic packages: ≥ 90 %
- Handler/controller packages: ≥ 85 %
- Utility packages: ≥ 95 %

Run `go test -race -coverprofile=coverage.out ./...` in CI and fail if coverage drops below thresholds.

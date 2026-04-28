# Go Coding Standards

## GO-CODING-001: Errors must be handled — never `_` discard
Do not discard errors with `_`. Every returned `error` must be either returned to the caller, logged with context, or explicitly documented why it is safe to ignore (rare). Silent error discard hides real failures.

## GO-CODING-002: Wrap errors with context using `fmt.Errorf("%w")`
When returning an error from a deeper call, wrap it: `fmt.Errorf("loading user %d: %w", id, err)`. This preserves the error chain for `errors.Is`/`errors.As` while adding call-site context.

## GO-CODING-003: Use `context.Context` as the first parameter for I/O functions
Every function that performs I/O (database, HTTP, gRPC, file) must accept `ctx context.Context` as its first parameter and pass it to all downstream calls. This enables deadline propagation and cancellation.

## GO-CODING-004: No `panic` in library code
`panic` is only acceptable in `main()` for unrecoverable startup failures and in `init()` for invalid package-level state. Library functions must return errors. `recover()` is only for wrapping panics from untrusted code.

## GO-CODING-005: Prefer table-driven tests
Write test cases as a slice of structs (`[]struct{ name, input, want }`), not as separate `Test*` functions per case. Table-driven tests are easier to read, extend, and review.

## GO-CODING-006: Use `sync.Mutex` or channels — not raw memory sharing
Do not share mutable state between goroutines without synchronisation. Pass ownership via channels or protect with `sync.Mutex`/`sync.RWMutex`. Use the `go vet -race` detector in CI.

## GO-CODING-007: Struct fields must have JSON tags if serialised
Any struct field that participates in JSON encoding/decoding must have an explicit `json:"name"` tag. Relying on default field-name capitalisation produces API instability when fields are renamed.

## GO-CODING-008: No naked returns in functions longer than 5 lines
Named return variables with bare `return` statements are hard to read in anything longer than a trivial helper. Use explicit returns with named values.

## GO-CODING-009: Use `golangci-lint` configured rules
All Go code must pass the project's `golangci-lint` configuration without warnings. New linter suppressions (`//nolint:`) require a comment explaining why the suppression is justified.

## GO-CODING-010: `defer` for resource cleanup
All resources that require explicit closure (files, DB connections, HTTP response bodies) must be closed with `defer` immediately after a successful open/acquire, to prevent leaks on early returns.

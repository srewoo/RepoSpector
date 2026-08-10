# Go Performance Standards

## GO-PERF-001: Pre-allocate slice capacity when the size is known
`append` in a loop without capacity reallocates and copies repeatedly. Use `make([]T, 0, len(src))`.

## GO-PERF-002: No string concatenation in a loop
`s += x` allocates a new string every iteration. Use `strings.Builder`.

## GO-PERF-003: No nested iteration over the same collection
Two nested loops over the same slice is O(n²). Build a map for the lookup.

## GO-PERF-004: Parallelise independent I/O
Sequential HTTP or database calls with no ordering dependency should run under `errgroup.Group`.

## GO-PERF-005: Avoid reflection on hot paths
Reflection bypasses type safety and is slow. Prefer generics or code generation where the type set is known.

## GO-PERF-006: Do not copy large structs by value
Passing or ranging over large structs by value copies them each time. Use a pointer, or index the slice.
